import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { ActivityIndicator, Banner, Button, Snackbar, Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { isApiClientError } from '../api/errors';
import { useApi } from '../api/useApi';
import {
  daysLeftInPeriod,
  formatDateTime,
  formatPeriodLabel,
  HOUSEHOLD_TZ_FALLBACK,
  zonedYmd,
} from '../format/time';
import { shouldRetryQuery } from '../providers';
import { useCategoryStyleById } from '../categories/useCategoryStyle';
import { comparisonAt, cumulative } from '../charts/geometry';
import { PaceChart } from '../charts/PaceChart';
import { useAppTheme } from '../theme';
import { useCategories } from '../transactions/queries';
import { groupForHome } from './budget-math';
import { CategoryList, type DrillPeriod } from './CategoryList';
import { HomeSummary, type Comparison } from './HomeSummary';
import { PeriodHeader, type HomePeriod } from './PeriodHeader';
import { compactSyncText, SyncStatusBar } from './SyncStatusBar';

function isNetworkError(error: unknown): boolean {
  return isApiClientError(error) && error.error.kind === 'network';
}

function daysLeftText(endIso: string): string | undefined {
  if (Number.isNaN(Date.parse(endIso))) return undefined;
  const n = daysLeftInPeriod(endIso);
  return n === 1 ? '1 day left' : `${n} days left`;
}

/** Days of a period (`end` exclusive) in the household time zone. */
function periodDayCount(start: string, end: string): number {
  const s = Date.parse(start);
  const e = Date.parse(end);
  if (Number.isNaN(s) || Number.isNaN(e) || e <= s) return 0;
  const a = zonedYmd(s, HOUSEHOLD_TZ_FALLBACK);
  const b = zonedYmd(e - 1, HOUSEHOLD_TZ_FALLBACK);
  return Math.round((Date.UTC(b.y, b.m, b.d) - Date.UTC(a.y, a.m, a.d)) / 86_400_000) + 1;
}

function longMonth(date: Date): string {
  return new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' }).format(date);
}

/** The month before the one `start` falls in (household time zone): its `YYYY-MM` key and name. */
function monthBefore(start: string): { key: string; name: string } | null {
  const s = Date.parse(start);
  if (Number.isNaN(s)) return null;
  const { y, m } = zonedYmd(s, HOUSEHOLD_TZ_FALLBACK);
  const date = new Date(Date.UTC(y, m - 1, 1));
  return {
    key: `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`,
    name: longMonth(date),
  };
}

function monthName(start: string): string {
  const s = Date.parse(start);
  if (Number.isNaN(s)) return 'this month';
  const { y, m } = zonedYmd(s, HOUSEHOLD_TZ_FALLBACK);
  return longMonth(new Date(Date.UTC(y, m, 1)));
}

export function HomeScreen() {
  const theme = useAppTheme();
  const api = useApi();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const styleOf = useCategoryStyleById();
  const categories = useCategories();
  const [period, setPeriod] = useState<HomePeriod>('current');
  const [refreshing, setRefreshing] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const home = useQuery({
    queryKey: ['home', period],
    queryFn: () => api.getHome(period),
    // An unreachable server must surface within seconds, not after a long retry chain.
    retry: (count, error) => (isNetworkError(error) ? count < 1 : shouldRetryQuery(count, error)),
    networkMode: 'always',
  });
  const { data, refetch } = home;

  // The comparison series: `previous` for the current period, the explicit month before otherwise.
  const before = data ? monthBefore(data.period.start) : null;
  const previousSpec = period === 'current' ? 'previous' : (before?.key ?? null);
  const previousHome = useQuery({
    queryKey: ['home', previousSpec],
    queryFn: () => api.getHome(previousSpec ?? 'previous'),
    enabled: previousSpec !== null && data !== undefined,
    retry: false,
    networkMode: 'always',
  });
  const previousDaily = previousHome.data?.daily;

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      // Sync only the caller's own healthy connectors; others belong to other members.
      const own = (data?.sync ?? []).filter((c) => c.isOwner && c.status === 'ok');
      const results = await Promise.allSettled(own.map((c) => api.syncConnector(c.id)));
      const syncFailed = results.some(
        (r) =>
          r.status === 'rejected' &&
          !(isApiClientError(r.reason) && r.reason.error.kind === 'rate_limited'),
      );
      const waits = results.flatMap((r) =>
        r.status === 'rejected' &&
        isApiClientError(r.reason) &&
        r.reason.error.kind === 'rate_limited'
          ? [r.reason.error.retryAfterSec]
          : [],
      );
      if (waits.length > 0) {
        setToast(`Already syncing, try again in ${Math.min(...waits)} s`);
      } else if (syncFailed) {
        setToast('Sync failed');
      }
      await refetch();
    } finally {
      setRefreshing(false);
    }
  }, [api, data, refetch]);

  const goToConnections = useCallback(() => {
    router.push('/connections');
  }, [router]);

  const openCategory = useCallback(
    (categoryId: string | null, span?: DrillPeriod) => {
      if (!data) return;
      // The period's end is exclusive; the transactions filter takes inclusive booking dates.
      const start = Date.parse((span ?? data.period).start);
      const end = Date.parse((span ?? data.period).end);
      const period =
        Number.isNaN(start) || Number.isNaN(end)
          ? {}
          : {
              from: zonedYmd(start, HOUSEHOLD_TZ_FALLBACK).iso,
              to: zonedYmd(Math.max(start, end - 1), HOUSEHOLD_TZ_FALLBACK).iso,
            };
      router.push({
        pathname: '/transactions',
        params: {
          ...(categoryId === null ? { uncategorized: '1' } : { categoryId }),
          ...period,
          n: String(Date.now()),
        },
      });
    },
    [data, router],
  );

  const failed = home.isError;
  const offline = isNetworkError(home.error);

  const syncText = data && !failed ? compactSyncText(data.sync) : null;
  const currentCumulative = data ? cumulative(data.daily) : [];
  const pace =
    data && period === 'current' && previousDaily
      ? comparisonAt(currentCumulative, cumulative(previousDaily))
      : null;
  const diff = pace ? pace.current - pace.previous : 0n;
  const comparison: Comparison | null =
    data && pace && diff !== 0n
      ? {
          less: diff < 0n,
          amount: {
            minor: (diff < 0n ? -diff : diff).toString(),
            currency: data.income.currency,
          },
        }
      : null;
  const names = new Map((categories.data ?? []).map((c) => [c.id, c.name]));

  let body;
  if (data) {
    const dayCount = periodDayCount(data.period.start, data.period.end);
    body = (
      <>
        {failed ? (
          <Banner
            visible
            icon={offline ? 'wifi-off' : 'alert-circle-outline'}
            actions={[{ label: 'Retry', onPress: () => void refetch(), loading: home.isFetching }]}
            testID="offline-banner"
          >
            {offline
              ? `Offline — showing data from ${formatDateTime(home.dataUpdatedAt)}`
              : `Couldn't refresh — showing data from ${formatDateTime(home.dataUpdatedAt)}`}
          </Banner>
        ) : null}
        <View style={styles.content}>
          <SyncStatusBar connectors={data.sync} onNeedsAttention={goToConnections} />
          <HomeSummary data={data} comparison={comparison} current={period === 'current'} />
          {data.daily.length > 0 && dayCount > 0 ? (
            <PaceChart
              current={data.daily}
              previous={previousDaily}
              dayCount={dayCount}
              showToday={period === 'current'}
              currency={data.income.currency}
              labels={{
                current: period === 'current' ? 'this month' : monthName(data.period.start),
                previous: before?.name ?? 'last month',
              }}
            />
          ) : null}
          <CategoryList
            groups={groupForHome(data.budgets, data.breakdown, names)}
            fxMissing={data.fxMissing}
            styleOf={styleOf}
            onOpenCategory={openCategory}
          />
        </View>
      </>
    );
  } else if (failed) {
    body = (
      <View style={styles.empty} testID="home-error">
        <Text variant="titleMedium">{offline ? "You're offline" : 'Something went wrong'}</Text>
        <Text variant="bodyMedium" style={{ textAlign: 'center' }}>
          {offline
            ? "The server can't be reached and there is no saved data yet."
            : "The data couldn't be loaded."}
        </Text>
        <Button mode="contained" onPress={() => void refetch()} loading={home.isFetching}>
          Retry
        </Button>
      </View>
    );
  } else {
    body = (
      <View style={styles.empty}>
        <ActivityIndicator animating accessibilityLabel="Loading" />
      </View>
    );
  }

  return (
    <View style={[styles.flex, { backgroundColor: theme.colors.background }]}>
      <ScrollView
        testID="home-scroll"
        contentContainerStyle={{ paddingTop: insets.top + 16, paddingBottom: 32 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void onRefresh()}
            colors={[theme.colors.primary]}
            tintColor={theme.colors.primary}
            progressBackgroundColor={theme.colors.elevation.level3}
          />
        }
      >
        <View style={styles.header}>
          <PeriodHeader
            value={period}
            onChange={setPeriod}
            title={
              data
                ? formatPeriodLabel(data.period.kind, data.period.start, data.period.end)
                : period === 'current'
                  ? 'This period'
                  : 'Previous period'
            }
            subtitle={
              !data
                ? undefined
                : [
                    period === 'previous' ? 'Previous period' : daysLeftText(data.period.end),
                    syncText,
                  ]
                    .filter(Boolean)
                    .join(' · ')
            }
          />
        </View>
        {body}
      </ScrollView>
      <Snackbar visible={toast !== null} onDismiss={() => setToast(null)} duration={4000}>
        {toast ?? ''}
      </Snackbar>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  // The arrow buttons carry their own touch padding, so the header row sits a little wider.
  header: { paddingHorizontal: 4, paddingBottom: 8 },
  content: { paddingHorizontal: 16, gap: 24 },
  empty: { padding: 24, gap: 16, alignItems: 'center' },
});

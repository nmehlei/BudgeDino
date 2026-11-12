import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { ActivityIndicator, Banner, Button, Divider, Snackbar, Text } from 'react-native-paper';
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
import { useIsAdmin } from '../household/queries';
import { shouldRetryQuery } from '../providers';
import { useAppTheme } from '../theme';
import { BudgetRow } from './BudgetRow';
import { HomeSummary } from './HomeSummary';
import { PeriodHeader, type HomePeriod } from './PeriodHeader';
import { SpendingList } from './SpendingList';
import { SyncStatusBar } from './SyncStatusBar';

function isNetworkError(error: unknown): boolean {
  return isApiClientError(error) && error.error.kind === 'network';
}

function daysLeftText(endIso: string): string | undefined {
  if (Number.isNaN(Date.parse(endIso))) return undefined;
  const n = daysLeftInPeriod(endIso);
  return n === 1 ? '1 day left' : `${n} days left`;
}

export function HomeScreen() {
  const theme = useAppTheme();
  const api = useApi();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  // Only admins can edit budgets (the edit screen is read-only otherwise), so only they get a tap target.
  const isAdmin = useIsAdmin();
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
    (categoryId: string | null) => {
      if (!data) return;
      // The period's end is exclusive; the transactions filter takes inclusive booking dates.
      const start = Date.parse(data.period.start);
      const end = Date.parse(data.period.end);
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

  const openBudget = useCallback(
    (id: string) => {
      router.push(`/more/budgets/${id}`);
    },
    [router],
  );

  const failed = home.isError;
  const offline = isNetworkError(home.error);

  let body;
  if (data) {
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
          <HomeSummary data={data} />
          <View>
            <Text variant="titleSmall" style={styles.sectionTitle} accessibilityRole="header">
              Budgets
            </Text>
            {data.budgets.length === 0 ? (
              <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                No budgets yet.
              </Text>
            ) : (
              data.budgets.map((b, i) => (
                <View key={b.id}>
                  {i > 0 ? <Divider /> : null}
                  <BudgetRow
                    budget={b}
                    homePeriodKind={data.period.kind}
                    onPress={isAdmin ? () => openBudget(b.id) : undefined}
                  />
                </View>
              ))
            )}
          </View>
          <SpendingList
            breakdown={data.breakdown}
            fxMissing={data.fxMissing}
            onSelectCategory={openCategory}
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
                : period === 'previous'
                  ? 'Previous period'
                  : daysLeftText(data.period.end)
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
  sectionTitle: { marginBottom: 4 },
  empty: { padding: 24, gap: 16, alignItems: 'center' },
});

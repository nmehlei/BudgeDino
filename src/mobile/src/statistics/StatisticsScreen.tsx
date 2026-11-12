import type { StatisticsResponse } from '@budgedino/shared';
import { useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import {
  ActivityIndicator,
  Banner,
  Button,
  SegmentedButtons,
  Text,
  TouchableRipple,
} from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { isApiClientError } from '../api/errors';
import { CategoryIcon } from '../categories/CategoryIcon';
import { useCategoryStyleById } from '../categories/useCategoryStyle';
import { MonthBars, type BarMonth } from '../charts/MonthBars';
import { formatMoney } from '../format/money';
import { formatDateTime, HOUSEHOLD_TZ_FALLBACK, zonedYmd } from '../format/time';
import { useAppTheme, useWarningColor } from '../theme';
import { useStatistics } from './queries';

const TOP_COUNT = 5;

type Category = StatisticsResponse['categories'][number];

function isNetworkError(error: unknown): boolean {
  return isApiClientError(error) && error.error.kind === 'network';
}

/**
 * Change of `trendSpent` (complete months of the window) against `previousSpent` in whole percent, rounded
 * half away from zero, with bigint maths only. Null when the history is incomplete (`previousSpent` null),
 * there is no previous spending to compare with, or the change rounds to 0.
 */
export function trendOf(
  trendSpent: string,
  previousSpent: string | null,
): { up: boolean; percent: bigint } | null {
  if (previousSpent === null) return null;
  const prev = BigInt(previousSpent);
  if (prev <= 0n) return null;
  const diff = BigInt(trendSpent) - prev;
  const abs = diff < 0n ? -diff : diff;
  const percent = (abs * 200n + prev) / (2n * prev);
  if (percent === 0n) return null;
  return { up: diff > 0n, percent };
}

/** Inclusive first and last booking day of `[start, end)` in the household time zone. */
function dayRange(start: string, end: string): { from?: string; to?: string } {
  const s = Date.parse(start);
  const e = Date.parse(end);
  if (Number.isNaN(s) || Number.isNaN(e)) return {};
  return {
    from: zonedYmd(s, HOUSEHOLD_TZ_FALLBACK).iso,
    to: zonedYmd(Math.max(s, e - 1), HOUSEHOLD_TZ_FALLBACK).iso,
  };
}

function CategoryRow({
  category,
  largest,
  style,
  onPress,
}: {
  category: Category;
  largest: bigint;
  style: { icon: string; color: string };
  onPress: () => void;
}) {
  const theme = useAppTheme();
  const warning = useWarningColor();
  const id = category.categoryId ?? 'uncategorized';
  const spent = BigInt(category.spent.minor);
  const share = largest > 0n && spent > 0n ? Number((spent * 10_000n) / largest) / 100 : 0;
  const trend = trendOf(category.trendSpent.minor, category.previousSpent?.minor ?? null);
  const value = formatMoney(category.spent);
  const trendText = trend ? `${trend.up ? '▲' : '▼'} ${trend.percent} %` : null;
  return (
    <TouchableRipple
      testID={`category-row-${id}`}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${category.name}, ${value}${
        trend ? `, ${trend.up ? 'up' : 'down'} ${trend.percent} percent` : ''
      }. Show transactions`}
    >
      <View style={styles.row}>
        <CategoryIcon icon={style.icon} color={style.color} size="md" />
        <View style={styles.rowBody}>
          <View style={styles.rowLine}>
            <Text variant="bodyLarge" style={[styles.name, { color: theme.colors.onSurface }]}>
              {category.name}
            </Text>
            {/* Own non-shrinking Text: the amount never splits from its currency sign. */}
            <Text variant="bodyLarge" style={[styles.amount, { color: theme.colors.onSurface }]}>
              {value}
            </Text>
          </View>
          <View style={styles.rowLine}>
            <View style={[styles.track, { backgroundColor: theme.colors.surfaceVariant }]}>
              <View
                testID={`category-share-${id}`}
                style={[styles.fill, { width: `${share}%`, backgroundColor: style.color }]}
              />
            </View>
            {trendText ? (
              <Text
                testID={`category-trend-${id}`}
                variant="labelMedium"
                style={[styles.trend, { color: trend?.up ? warning : theme.colors.primary }]}
              >
                {trendText}
              </Text>
            ) : null}
          </View>
        </View>
      </View>
    </TouchableRipple>
  );
}

export function StatisticsScreen() {
  const theme = useAppTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const styleOf = useCategoryStyleById();
  const [months, setMonths] = useState<6 | 12>(6);
  const [showAll, setShowAll] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const stats = useStatistics(months);
  const { data, refetch } = stats;

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refetch();
    } finally {
      setRefreshing(false);
    }
  }, [refetch]);

  const drill = useCallback(
    (params: Record<string, string>) => {
      router.push({ pathname: '/transactions', params: { ...params, n: String(Date.now()) } });
    },
    [router],
  );

  const openMonth = useCallback(
    (m: BarMonth) => drill(dayRange(m.start, m.end) as Record<string, string>),
    [drill],
  );

  const failed = stats.isError;
  const offline = isNetworkError(stats.error);
  const hasCompleteMonth = data ? data.months.some((m) => !m.partial) : false;

  let body;
  if (data) {
    const first = data.months[0];
    const last = data.months[data.months.length - 1];
    const window = first && last ? dayRange(first.start, last.end) : {};
    const visible = showAll ? data.categories : data.categories.slice(0, TOP_COUNT);
    const largest = data.categories.reduce((acc, c) => {
      const v = BigInt(c.spent.minor);
      return v > acc ? v : acc;
    }, 0n);
    const kept = data.averageKept;
    const keptMinor = kept ? BigInt(kept.minor) : 0n;
    body = (
      <>
        {failed ? (
          <Banner
            visible
            icon={offline ? 'wifi-off' : 'alert-circle-outline'}
            actions={[{ label: 'Retry', onPress: () => void refetch(), loading: stats.isFetching }]}
            testID="offline-banner"
          >
            {offline
              ? `Offline — showing data from ${formatDateTime(stats.dataUpdatedAt)}`
              : `Couldn't refresh — showing data from ${formatDateTime(stats.dataUpdatedAt)}`}
          </Banner>
        ) : null}
        {hasCompleteMonth ? (
          <View style={styles.content}>
            <SegmentedButtons
              value={String(months)}
              onValueChange={(v) => {
                setMonths(v === '12' ? 12 : 6);
                setShowAll(false);
              }}
              buttons={[
                { value: '6', label: '6 months' },
                { value: '12', label: '12 months' },
              ]}
            />
            <View style={styles.section}>
              <Text variant="titleMedium" accessibilityRole="header">
                Income vs spending
              </Text>
              <MonthBars months={data.months} onSelectMonth={openMonth} />
              {kept ? (
                <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                  {keptMinor >= 0n
                    ? `You kept on average ${formatMoney(kept)} a month`
                    : `You spent on average ${formatMoney({ minor: -keptMinor, currency: kept.currency })} more than you earned`}
                </Text>
              ) : null}
            </View>
            <View style={styles.section}>
              <Text variant="titleMedium" accessibilityRole="header">
                {`Top categories, ${months} months`}
              </Text>
              {data.categories.length === 0 ? (
                <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                  No spending in this period.
                </Text>
              ) : (
                <View testID="statistics-categories">
                  {visible.map((c) => (
                    <CategoryRow
                      key={c.categoryId ?? 'uncategorized'}
                      category={c}
                      largest={largest}
                      style={styleOf(c.categoryId)}
                      onPress={() =>
                        drill({
                          ...(c.categoryId === null
                            ? { uncategorized: '1' }
                            : { categoryId: c.categoryId }),
                          ...(window as Record<string, string>),
                        })
                      }
                    />
                  ))}
                  {data.categories.length > TOP_COUNT ? (
                    <Button mode="text" onPress={() => setShowAll((v) => !v)}>
                      {showAll ? 'Show less' : 'Show all'}
                    </Button>
                  ) : null}
                </View>
              )}
              {data.fxMissing ? (
                <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                  Some foreign amounts couldn&apos;t be converted.
                </Text>
              ) : null}
            </View>
          </View>
        ) : (
          <View style={styles.empty} testID="statistics-empty">
            <Text variant="bodyLarge" style={styles.center}>
              Statistics appear after your first full month.
            </Text>
          </View>
        )}
      </>
    );
  } else if (failed) {
    body = (
      <View style={styles.empty} testID="statistics-error">
        <Text variant="titleMedium">{offline ? "You're offline" : 'Something went wrong'}</Text>
        <Text variant="bodyMedium" style={styles.center}>
          {offline
            ? "The server can't be reached and there is no saved data yet."
            : "The data couldn't be loaded."}
        </Text>
        <Button mode="contained" onPress={() => void refetch()} loading={stats.isFetching}>
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
        testID="statistics-scroll"
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
          <Text variant="headlineSmall" accessibilityRole="header">
            Statistics
          </Text>
        </View>
        {body}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  header: { paddingHorizontal: 16, paddingBottom: 16 },
  content: { paddingHorizontal: 16, gap: 24 },
  section: { gap: 12 },
  empty: { padding: 24, gap: 16, alignItems: 'center' },
  center: { textAlign: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 },
  rowBody: { flex: 1, gap: 6 },
  rowLine: { flexDirection: 'row', alignItems: 'center', columnGap: 8 },
  name: { flex: 1 },
  amount: { flexShrink: 0, textAlign: 'right', fontVariant: ['tabular-nums'] },
  track: { flex: 1, height: 6, borderRadius: 3, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 3 },
  trend: { flexShrink: 0 },
});

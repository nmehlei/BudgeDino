import type { StatisticsResponse } from '@budgedino/shared';
import { useState } from 'react';
import { Animated, type LayoutChangeEvent, Pressable, StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';

import { useCategoryColor } from '../categories/useCategoryStyle';
import { formatWholeMoney as formatWhole } from '../format/whole-money';
import { useAppTheme } from '../theme';
import { niceMax } from './geometry';
import { useDrawIn } from './useDrawIn';

export type BarMonth = StatisticsResponse['months'][number];

const PLOT_H = 120;
const PARTIAL_OPACITY = 0.45;
const MONTHS_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
/** A group narrower than this (dp) shows a label only for every other month. */
const EVERY_LABEL_MIN_SLOT = 30;
/** A group at least this wide has room for "so far" next to the partial month's name. */
const SO_FAR_MIN_SLOT = 50;

function parseKey(key: string): { year: string; month: number } {
  const [y, m] = key.split('-');
  return { year: y ?? '', month: Math.max(0, Math.min(11, Number(m) - 1)) };
}

function height(minor: string, max: bigint): number {
  const v = BigInt(minor);
  if (v <= 0n || max <= 0n) return 0;
  return Math.round((Number(v) / Number(max)) * PLOT_H * 100) / 100;
}

/**
 * Grouped bars per month: income in the accent colour, spending in the orange category colour, the partial
 * (current) month faded. Built from plain Views (no SVG), scaled on `niceMax` of the largest value. Labels
 * are short month names under each group; when a group is narrower than 30 dp (12 months on a phone) only
 * every other month is labelled, counting back from the newest so it is always the one labelled. The
 * partial month reads "<Mon> so far" when its group is at least 50 dp wide. Each group is a Pressable.
 */
export function MonthBars({
  months,
  onSelectMonth,
}: {
  months: BarMonth[];
  onSelectMonth: (month: BarMonth) => void;
}) {
  const theme = useAppTheme();
  const spendingColor = useCategoryColor('orange');
  const [width, setWidth] = useState(0);
  const fade = useDrawIn();
  const onLayout = (e: LayoutChangeEvent) => setWidth(Math.round(e.nativeEvent.layout.width));

  const currency = months[0]?.income.currency ?? 'EUR';
  const peak = months.reduce((acc, m) => {
    const a = BigInt(m.income.minor);
    const b = BigInt(m.spending.minor);
    return [a, b].reduce((x, y) => (y > x ? y : x), acc);
  }, 0n);
  const max = niceMax(peak);
  const slot = months.length > 0 ? width / months.length : 0;
  const barW = Math.max(3, Math.min(16, Math.floor((slot * 0.72) / 2)));
  const muted = theme.colors.onSurfaceVariant;
  const grid = theme.colors.outlineVariant;

  return (
    <View testID="month-bars">
      <View onLayout={onLayout} style={styles.plot} testID="month-bars-plot">
        {width > 0 ? (
          <Animated.View style={{ opacity: fade }}>
            <View style={[styles.gridLine, { top: 0, backgroundColor: grid }]} />
            <View style={[styles.gridLine, { top: PLOT_H / 2, backgroundColor: grid }]} />
            <Text variant="labelSmall" style={[styles.gridLabel, { top: -14, color: muted }]}>
              {formatWhole(max, currency)}
            </Text>
            <Text
              variant="labelSmall"
              style={[styles.gridLabel, { top: PLOT_H / 2 - 14, color: muted }]}
            >
              {formatWhole(max / 2n, currency)}
            </Text>
            <View style={styles.groups}>
              {months.map((m, i) => {
                const { year, month } = parseKey(m.key);
                const faded = m.partial ? PARTIAL_OPACITY : 1;
                const fromEnd = months.length - 1 - i;
                const labelled = slot >= EVERY_LABEL_MIN_SLOT || fromEnd % 2 === 0;
                const short = MONTHS_SHORT[month] ?? '';
                const label = m.partial && slot >= SO_FAR_MIN_SLOT ? `${short} so far` : short;
                const income = formatWhole(BigInt(m.income.minor), m.income.currency);
                const spending = formatWhole(BigInt(m.spending.minor), m.spending.currency);
                return (
                  <Pressable
                    key={m.key}
                    testID={`month-group-${m.key}`}
                    accessibilityRole="button"
                    accessibilityLabel={`${MONTHS_LONG[month] ?? ''} ${year}${m.partial ? ' (so far)' : ''}: income ${income}, spending ${spending}`}
                    onPress={() => onSelectMonth(m)}
                    style={styles.group}
                  >
                    <View style={[styles.bars, { height: PLOT_H }]}>
                      <View
                        testID={`bar-income-${m.key}`}
                        style={[
                          styles.bar,
                          {
                            width: barW,
                            height: height(m.income.minor, max),
                            backgroundColor: theme.colors.primary,
                            opacity: faded,
                          },
                        ]}
                      />
                      <View
                        testID={`bar-spending-${m.key}`}
                        style={[
                          styles.bar,
                          {
                            width: barW,
                            height: height(m.spending.minor, max),
                            backgroundColor: spendingColor,
                            opacity: faded,
                          },
                        ]}
                      />
                    </View>
                    <Text
                      variant="labelSmall"
                      style={[styles.monthLabel, { color: muted }]}
                      importantForAccessibility="no"
                    >
                      {labelled ? label : ' '}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </Animated.View>
        ) : null}
      </View>
      <View style={styles.legend}>
        <View style={[styles.swatch, { backgroundColor: theme.colors.primary }]} />
        <Text variant="labelSmall" style={{ color: muted }}>
          Income
        </Text>
        <View style={[styles.swatch, { backgroundColor: spendingColor }]} />
        <Text variant="labelSmall" style={{ color: muted }}>
          Spending
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Room above the plot for the top gridline's value label.
  plot: { width: '100%', minHeight: PLOT_H + 40, paddingTop: 16 },
  gridLine: { position: 'absolute', left: 0, right: 0, height: StyleSheet.hairlineWidth },
  gridLabel: { position: 'absolute', right: 0 },
  groups: { flexDirection: 'row' },
  group: { flex: 1, alignItems: 'center', minHeight: 44 },
  bars: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'center', gap: 2 },
  bar: { borderTopLeftRadius: 4, borderTopRightRadius: 4 },
  monthLabel: { marginTop: 4, textAlign: 'center' },
  legend: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 },
  swatch: { width: 10, height: 10, borderRadius: 5, marginLeft: 6 },
});

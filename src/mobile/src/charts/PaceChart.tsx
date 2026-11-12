import { currencyExponent } from '@budgedino/shared';
import { useId, useState } from 'react';
import { Animated, type LayoutChangeEvent, StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';
import Svg, {
  Circle,
  Defs,
  Line,
  LinearGradient,
  Path,
  Stop,
  Text as SvgText,
} from 'react-native-svg';

import { formatMoney } from '../format/money';
import { useAppTheme } from '../theme';
import { comparisonAt, cumulative, linePath, niceMax } from './geometry';
import { useDrawIn } from './useDrawIn';

export interface DailyPoint {
  date: string;
  spent: { minor: string; currency: string };
}

const HEIGHT = 150;
const TOP = 20;
const PAD = 6;
const BOTTOM = 4;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-11-01` plus `offset` days as `1 Nov` (UTC arithmetic, no timezone drift). */
function dayLabel(isoDate: string, offset: number): string {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d + offset));
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

export function PaceChart({
  current,
  previous,
  dayCount,
  showToday,
  currency,
  labels,
}: {
  current: DailyPoint[];
  previous: DailyPoint[] | undefined;
  dayCount: number;
  showToday: boolean;
  currency: string;
  labels: { current: string; previous: string };
}) {
  const theme = useAppTheme();
  const [width, setWidth] = useState(0);
  const fade = useDrawIn();
  const gradientId = `paceFill${useId().replace(/\W/g, '')}`;
  const onLayout = (e: LayoutChangeEvent) => setWidth(Math.round(e.nativeEvent.layout.width));

  const cur = cumulative(current);
  const prevAll = previous ? cumulative(previous) : [];
  const prevVisible = prevAll.length > 0 && (prevAll[prevAll.length - 1] as bigint) > 0n;
  // The previous line is drawn on the current period's scale and clipped at its right edge.
  const prev = prevVisible ? prevAll.slice(0, Math.max(dayCount, 1)) : [];
  const comparison = comparisonAt(cur, prevAll);

  const peak = [...cur, ...prev].reduce((a, b) => (b > a ? b : a), 0n);
  const max = niceMax(peak);
  const plotH = HEIGHT - TOP - BOTTOM;
  /** Whole currency units: drops the decimals the formatter adds. */
  const exponent = currencyExponent(currency);
  const fmt = (minor: bigint) => {
    const text = formatMoney({ minor, currency });
    return exponent === 0 ? text : text.replace(new RegExp(`,\\d{${exponent}}(?=\\D*$)`), '');
  };

  const plotW = Math.max(width - 2 * PAD, 0);
  const curPath = linePath(cur, dayCount, max, plotW, plotH);
  const prevPath = linePath(prev, dayCount, max, plotW, plotH);
  const last = cur.length - 1;
  const step = dayCount > 1 ? plotW / (dayCount - 1) : plotW;
  const endX = last * step;
  const endY = TOP + plotH - (Number(cur[last] ?? 0n) / Number(max)) * plotH;
  // A single point is drawn one day wide (see linePath); the fill closes under whatever the line covers.
  const fillEndX = cur.length > 1 ? endX : step;
  const fillPath = curPath ? `${curPath}L${fillEndX},${plotH}L0,${plotH}Z` : '';
  const firstDate = current[0]?.date;
  const todayX = Math.min(Math.max(endX + PAD, 18), Math.max(width - 18, 18));

  const a11y = comparison
    ? `Spent ${fmt(comparison.current)} so far ${labels.current}; ${fmt(comparison.previous)} by this day last month.`
    : `Spent ${fmt(cur[last] ?? 0n)} so far ${labels.current}.`;
  const grid = theme.colors.outlineVariant;
  const muted = theme.colors.onSurfaceVariant;
  const accent = theme.colors.primary;
  const shift = `translate(${PAD} ${TOP})`;

  return (
    <View accessible accessibilityLabel={a11y} testID="pace-chart">
      <View onLayout={onLayout} style={styles.plot} testID="pace-plot">
        {width > 0 ? (
          <Animated.View style={{ opacity: fade }}>
            <Svg width={width} height={HEIGHT}>
              <Defs>
                <LinearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <Stop offset="0" stopColor={accent} stopOpacity={0.28} />
                  <Stop offset="1" stopColor={accent} stopOpacity={0} />
                </LinearGradient>
              </Defs>
              <Line x1={0} x2={width} y1={TOP} y2={TOP} stroke={grid} strokeWidth={1} />
              <Line
                x1={0}
                x2={width}
                y1={TOP + plotH / 2}
                y2={TOP + plotH / 2}
                stroke={grid}
                strokeWidth={1}
              />
              <SvgText x={width} y={TOP - 3} fontSize={10} fill={muted} textAnchor="end">
                {fmt(max)}
              </SvgText>
              <SvgText
                x={width}
                y={TOP + plotH / 2 - 3}
                fontSize={10}
                fill={muted}
                textAnchor="end"
              >
                {fmt(max / 2n)}
              </SvgText>
              {prevPath ? (
                <Path
                  testID="pace-previous-path"
                  d={prevPath}
                  transform={shift}
                  stroke={muted}
                  strokeWidth={1.5}
                  strokeDasharray="4 4"
                  fill="none"
                />
              ) : null}
              {fillPath ? (
                <Path
                  testID="pace-fill-path"
                  d={fillPath}
                  transform={shift}
                  fill={`url(#${gradientId})`}
                />
              ) : null}
              {curPath ? (
                <Path
                  testID="pace-current-path"
                  d={curPath}
                  transform={shift}
                  stroke={accent}
                  strokeWidth={2.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill="none"
                />
              ) : null}
              {showToday && cur.length > 0 ? (
                <Circle
                  testID="pace-today-dot"
                  cx={endX + PAD}
                  cy={endY}
                  r={5}
                  fill={accent}
                  stroke={theme.colors.surface}
                  strokeWidth={2}
                />
              ) : null}
            </Svg>
          </Animated.View>
        ) : null}
      </View>
      {firstDate ? (
        <View style={styles.xLabels}>
          <Text variant="labelSmall" style={{ color: muted }}>
            {dayLabel(firstDate, 0)}
          </Text>
          {showToday ? (
            <Text
              variant="labelSmall"
              style={[
                styles.today,
                { color: accent, left: todayX - 18, minWidth: 36, textAlign: 'center' },
              ]}
              testID="pace-today-label"
            >
              today
            </Text>
          ) : null}
          <Text variant="labelSmall" style={{ color: muted }}>
            {dayLabel(firstDate, dayCount - 1)}
          </Text>
        </View>
      ) : null}
      <View style={styles.legend}>
        <View style={[styles.swatch, { backgroundColor: accent }]} />
        <Text variant="labelSmall" style={{ color: muted }}>
          {labels.current}
        </Text>
        {prevPath ? (
          <>
            <View style={[styles.swatch, styles.dashed, { borderColor: muted }]} />
            <Text variant="labelSmall" style={{ color: muted }}>
              {labels.previous}
            </Text>
          </>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  plot: { height: HEIGHT, width: '100%' },
  xLabels: { flexDirection: 'row', justifyContent: 'space-between', minHeight: 18 },
  today: { position: 'absolute' },
  legend: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 },
  swatch: { width: 16, height: 3, borderRadius: 2, marginLeft: 6 },
  dashed: { height: 0, borderTopWidth: 2, borderStyle: 'dashed', backgroundColor: 'transparent' },
});

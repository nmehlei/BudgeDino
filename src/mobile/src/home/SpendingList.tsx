import type { HomeResponse } from '@budgedino/shared';
import { StyleSheet, View } from 'react-native';
import { Icon, Text, TouchableRipple } from 'react-native-paper';

import { formatMoney } from '../format/money';
import { useAppTheme } from '../theme';
import { shareWidths } from './budget-math';

type Breakdown = HomeResponse['breakdown'];

function big(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

/** Largest spend first (the server already sorts; this keeps the order stable if it ever doesn't). */
export function sortBreakdown(items: Breakdown): Breakdown {
  return [...items].sort((a, b) => {
    const x = big(a.spent.minor);
    const y = big(b.spent.minor);
    return x === y ? 0 : x < y ? 1 : -1;
  });
}

/**
 * The "Spending" section: one row per category (largest first) with its amount, a chevron when it
 * drills down, and a thin bar showing its share of the period's spending.
 */
export function SpendingList({
  breakdown,
  fxMissing,
  onSelectCategory,
}: Pick<HomeResponse, 'breakdown' | 'fxMissing'> & {
  /** Called with the category id, or null for the uncategorised row. */
  onSelectCategory?: (categoryId: string | null) => void;
}) {
  const theme = useAppTheme();
  const sorted = sortBreakdown(breakdown);
  const widths = shareWidths(sorted.map((i) => i.spent));
  return (
    <View>
      <Text variant="titleSmall" style={styles.title} accessibilityRole="header">
        Spending
      </Text>
      {sorted.length === 0 ? (
        <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
          No spending in this period.
        </Text>
      ) : (
        sorted.map((item, i) => {
          const value = formatMoney(item.spent);
          const width = widths[i] ?? 0;
          const content = (
            <View style={styles.row}>
              <View style={styles.line}>
                <Text variant="bodyLarge" style={styles.label}>
                  {item.name}
                </Text>
                <View style={styles.end}>
                  <Text variant="bodyLarge" style={styles.value}>
                    {value}
                  </Text>
                  {onSelectCategory ? (
                    <Icon source="chevron-right" size={20} color={theme.colors.onSurfaceVariant} />
                  ) : null}
                </View>
              </View>
              <View
                style={[styles.track, { backgroundColor: theme.colors.surfaceVariant }]}
                importantForAccessibility="no-hide-descendants"
                accessibilityElementsHidden
              >
                <View
                  testID="breakdown-share-fill"
                  style={[
                    styles.fill,
                    { width: `${width}%`, backgroundColor: theme.colors.primary },
                  ]}
                />
              </View>
            </View>
          );
          const key = item.categoryId ?? 'uncategorized';
          if (!onSelectCategory) {
            return (
              <View key={key} testID="breakdown-row">
                {content}
              </View>
            );
          }
          return (
            <TouchableRipple
              key={key}
              onPress={() => onSelectCategory(item.categoryId)}
              testID="breakdown-row"
              accessibilityRole="button"
              accessibilityLabel={`${item.name}, ${value}, ${Math.round(width)} percent of spending. Show transactions`}
            >
              {content}
            </TouchableRipple>
          );
        })
      )}
      {fxMissing ? (
        <Text variant="bodySmall" style={[styles.note, { color: theme.colors.onSurfaceVariant }]}>
          Some foreign amounts couldn&apos;t be converted.
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  title: { marginBottom: 4 },
  row: { paddingVertical: 10, gap: 6 },
  line: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    alignItems: 'center',
    columnGap: 12,
    rowGap: 2,
  },
  label: { flexShrink: 1 },
  end: { flexDirection: 'row', alignItems: 'center', flexShrink: 1, gap: 4 },
  value: { flexShrink: 1, textAlign: 'right', fontVariant: ['tabular-nums'] },
  track: { height: 4, borderRadius: 2, overflow: 'hidden' },
  // Reduced emphasis: the bar is context, the amount is the information.
  fill: { height: '100%', borderRadius: 2, opacity: 0.6 },
  note: { marginTop: 8 },
});

import type { BudgetView } from '@budgedino/shared';
import { StyleSheet, View } from 'react-native';
import { Text, TouchableRipple } from 'react-native-paper';

import { formatMoney } from '../format/money';
import { useAppTheme, useWarningColor } from '../theme';
import { barState, overBy, type BarLevel } from './budget-math';

const PERIOD_LABEL = { weekly: 'Weekly', monthly: 'Monthly' } as const;

export function useLevelColor(): Record<BarLevel, string> {
  const theme = useAppTheme();
  const warning = useWarningColor();
  return {
    ok: theme.colors.primary,
    warn: warning,
    over: theme.colors.error,
  };
}

/**
 * One budget as a compact row: name and "spent / amount", a thin bar coloured by level, and "Over by
 * <amount>" only when spending exceeds the budget. The period kind is shown only when it differs from
 * the Home period (e.g. a weekly budget on a monthly Home). Tappable only when `onPress` is given.
 */
export function BudgetRow({
  budget,
  homePeriodKind,
  onPress,
}: {
  budget: BudgetView;
  homePeriodKind?: BudgetView['periodKind'] | undefined;
  onPress?: (() => void) | undefined;
}) {
  const theme = useAppTheme();
  const colors = useLevelColor();
  const bar = barState(budget);
  const color = colors[bar.level];
  const spent = formatMoney(budget.spent);
  const amount = formatMoney(budget.amount);
  const over = bar.overBudget ? overBy(budget) : null;
  const overText = over ? `Over by ${formatMoney(over)}` : 'Over budget';

  const content = (
    <View style={styles.row}>
      <View style={styles.line}>
        <View style={styles.name}>
          <Text variant="bodyLarge" style={{ color: theme.colors.onSurface }}>
            {budget.name}
          </Text>
          {homePeriodKind !== undefined && homePeriodKind !== budget.periodKind ? (
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
              {PERIOD_LABEL[budget.periodKind]}
            </Text>
          ) : null}
        </View>
        <Text
          variant="bodyMedium"
          style={[styles.amounts, { color: theme.colors.onSurfaceVariant }]}
          testID="budget-amounts"
        >
          {`${spent} / ${amount}`}
        </Text>
      </View>
      <View
        testID="budget-bar-track"
        accessibilityRole="progressbar"
        accessibilityLabel={`${budget.name}: ${bar.usedPercent} percent used`}
        accessibilityValue={{ min: 0, max: 100, now: bar.fillPercent }}
        style={[styles.track, { backgroundColor: theme.colors.surfaceVariant }]}
      >
        <View
          testID="budget-bar-fill"
          style={[styles.fill, { width: `${bar.fillPercent}%`, backgroundColor: color }]}
        />
      </View>
      {bar.overBudget ? (
        <Text variant="labelMedium" style={{ color: theme.colors.error }} testID="budget-over">
          {overText}
        </Text>
      ) : null}
      {budget.fxMissing ? (
        <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
          Some foreign amounts couldn&apos;t be converted.
        </Text>
      ) : null}
    </View>
  );

  if (!onPress) return <View testID={`budget-${budget.id}`}>{content}</View>;
  return (
    <TouchableRipple
      testID={`budget-${budget.id}`}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${budget.name}, ${spent} of ${amount}${bar.overBudget ? `, ${overText.toLowerCase()}` : ''}. Edit budget`}
    >
      {content}
    </TouchableRipple>
  );
}

const styles = StyleSheet.create({
  row: { paddingVertical: 10, gap: 6 },
  line: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    columnGap: 12,
    rowGap: 2,
  },
  name: { flexShrink: 1 },
  amounts: { flexShrink: 1, textAlign: 'right', fontVariant: ['tabular-nums'] },
  track: { height: 6, borderRadius: 3, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 3 },
});

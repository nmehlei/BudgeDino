import type { BudgetView } from '@budgedino/shared';
import { StyleSheet, View } from 'react-native';
import { Surface, Text } from 'react-native-paper';

import { formatMoney } from '../format/money';
import { useAppTheme, useWarningColor } from '../theme';
import { barState, type BarLevel } from './budget-math';

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

/** One budget: name, period kind, large spent amount, "of <amount>", and a clamped progress bar. */
export function BudgetCard({ budget }: { budget: BudgetView }) {
  const theme = useAppTheme();
  const colors = useLevelColor();
  const bar = barState(budget);
  const color = colors[bar.level];
  const spent = formatMoney(budget.spent);
  const amount = formatMoney(budget.amount);

  return (
    <Surface
      testID={`budget-${budget.id}`}
      style={[styles.card, { backgroundColor: theme.colors.surfaceVariant }]}
      elevation={0}
    >
      <View style={styles.header}>
        <Text variant="titleMedium" style={styles.name}>
          {budget.name}
        </Text>
        <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant }}>
          {PERIOD_LABEL[budget.periodKind]}
        </Text>
      </View>
      <Text
        variant="headlineMedium"
        style={{ color: bar.overBudget ? color : theme.colors.onSurface }}
      >
        {spent}
      </Text>
      <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
        {`of ${amount}`}
      </Text>
      <View
        testID="budget-bar-track"
        accessibilityRole="progressbar"
        accessibilityLabel={`${budget.name}: ${bar.usedPercent} percent used`}
        accessibilityValue={{ min: 0, max: 100, now: bar.fillPercent }}
        style={[styles.track, { backgroundColor: theme.colors.outlineVariant }]}
      >
        <View
          testID="budget-bar-fill"
          style={{
            width: `${bar.fillPercent}%`,
            height: '100%',
            borderRadius: 4,
            backgroundColor: color,
          }}
        />
      </View>
      <View style={styles.footer}>
        <Text
          variant="labelMedium"
          style={{ color: bar.overBudget ? color : theme.colors.onSurface }}
        >
          {bar.overBudget ? `Over budget (${bar.usedPercent} %)` : `${bar.usedPercent} % used`}
        </Text>
      </View>
      {budget.fxMissing ? (
        <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
          Some foreign amounts couldn't be converted.
        </Text>
      ) : null}
    </Surface>
  );
}

const styles = StyleSheet.create({
  card: { padding: 16, borderRadius: 16, gap: 4 },
  header: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: 8 },
  name: { flexShrink: 1 },
  track: { height: 8, borderRadius: 4, overflow: 'hidden', marginTop: 8 },
  footer: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 4 },
});

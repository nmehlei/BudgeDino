import type { HomeResponse } from '@budgedino/shared';
import { StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';

import { formatMoney } from '../format/money';
import { useAppTheme } from '../theme';
import { sumMoney } from './budget-math';

function isZero(minor: string): boolean {
  try {
    return BigInt(minor) === 0n;
  } catch {
    return true;
  }
}

/**
 * The period at a glance, typography only (no card): total spending (sum of the breakdown, exact
 * bigint minor units), "of <amount> budgeted" for the budgets of the headline period's kind, and
 * income. Amounts are in the Home currency (`income.currency`); if any amount is in another one, the
 * total is left out instead of adding up different currencies.
 */
export function HomeSummary({
  data,
}: {
  data: Pick<HomeResponse, 'period' | 'budgets' | 'breakdown' | 'income' | 'uncategorizedIncome'>;
}) {
  const theme = useAppTheme();
  const currency = data.income.currency;
  const spent = sumMoney(
    data.breakdown.map((b) => b.spent),
    currency,
  );
  // Budgets of the other kind (weekly on a monthly Home) cover a different span, so they are not added.
  const sameKind = data.budgets.filter((b) => b.periodKind === data.period.kind);
  const budgeted =
    sameKind.length > 0
      ? sumMoney(
          sameKind.map((b) => b.amount),
          currency,
        )
      : null;
  const muted = { color: theme.colors.onSurfaceVariant };

  return (
    <View testID="home-summary">
      {spent ? (
        <Text variant="displaySmall" testID="summary-spent" style={styles.amount}>
          {formatMoney(spent)}
        </Text>
      ) : (
        <Text variant="bodyMedium" style={muted} testID="summary-mixed">
          Spending is in several currencies, so no total is shown.
        </Text>
      )}
      {spent && budgeted ? (
        <Text variant="bodyMedium" style={muted} testID="summary-budgeted">
          {`of ${formatMoney(budgeted)} budgeted`}
        </Text>
      ) : null}
      <View style={styles.income}>
        <Text variant="bodyMedium" style={muted} testID="income-row">
          {`Income ${formatMoney(data.income)}`}
        </Text>
        {!isZero(data.uncategorizedIncome.minor) ? (
          <Text variant="bodyMedium" style={muted} testID="uncategorized-income-row">
            {`Uncategorised income ${formatMoney(data.uncategorizedIncome)}`}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  amount: { fontVariant: ['tabular-nums'] },
  income: { marginTop: 8 },
});

import type { HomeResponse } from '@budgedino/shared';
import { StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';

import { formatMoney } from '../format/money';
import { useAppTheme, useWarningColor } from '../theme';
import { sumMoney } from './budget-math';

function isZero(minor: string): boolean {
  try {
    return BigInt(minor) === 0n;
  } catch {
    return true;
  }
}

/** How this period's pace compares with the previous one at the same day: `amount` is positive. */
export interface Comparison {
  less: boolean;
  amount: { minor: string; currency: string };
}

/**
 * The period at a glance, typography only (no card): total spending (sum of the breakdown, exact
 * bigint minor units) with "spent so far", one comparison line against the previous period, and a quiet
 * income line. Amounts are in the Home currency (`income.currency`); if any amount is in another one,
 * the total is left out instead of adding up different currencies.
 */
export function HomeSummary({
  data,
  comparison,
  current = true,
}: {
  data: Pick<HomeResponse, 'breakdown' | 'income' | 'uncategorizedIncome'>;
  comparison?: Comparison | null | undefined;
  /** False on the previous period: the total is final ("spent", not "spent so far"). */
  current?: boolean;
}) {
  const theme = useAppTheme();
  const warning = useWarningColor();
  const currency = data.income.currency;
  const spent = sumMoney(
    data.breakdown.map((b) => b.spent),
    currency,
  );
  const muted = { color: theme.colors.onSurfaceVariant };

  return (
    <View testID="home-summary">
      {spent ? (
        <View style={styles.headline}>
          <Text variant="displaySmall" testID="summary-spent" style={styles.amount}>
            {formatMoney(spent)}
          </Text>
          <Text variant="bodyMedium" style={muted}>
            {current ? 'spent so far' : 'spent'}
          </Text>
        </View>
      ) : (
        <Text variant="bodyMedium" style={muted} testID="summary-mixed">
          Spending is in several currencies, so no total is shown.
        </Text>
      )}
      {spent && comparison ? (
        <Text
          variant="bodyMedium"
          testID="summary-comparison"
          style={{ color: comparison.less ? theme.colors.primary : warning }}
        >
          {`${comparison.less ? '↓' : '↑'} ${formatMoney(comparison.amount)} ${comparison.less ? 'less' : 'more'} than by this day last month`}
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
  headline: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 8 },
  amount: { fontVariant: ['tabular-nums'] },
  income: { marginTop: 8 },
});

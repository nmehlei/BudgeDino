import type { HomeResponse } from '@budgedino/shared';
import { StyleSheet, View } from 'react-native';
import { Divider, Text } from 'react-native-paper';

import { formatMoney } from '../format/money';
import { useAppTheme } from '../theme';

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

function Row({ label, value, testID }: { label: string; value: string; testID?: string }) {
  return (
    <View style={styles.row} testID={testID}>
      <Text variant="bodyLarge" style={styles.label}>
        {label}
      </Text>
      <Text variant="bodyLarge" style={styles.value}>
        {value}
      </Text>
    </View>
  );
}

export function BreakdownList({
  breakdown,
  income,
  uncategorizedIncome,
  fxMissing,
}: Pick<HomeResponse, 'breakdown' | 'income' | 'uncategorizedIncome' | 'fxMissing'>) {
  const theme = useAppTheme();
  const sorted = sortBreakdown(breakdown);
  return (
    <View style={styles.container}>
      <Text variant="titleMedium">Spending</Text>
      {sorted.length === 0 ? (
        <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
          No spending in this period.
        </Text>
      ) : (
        sorted.map((item) => (
          <Row
            key={item.categoryId ?? 'uncategorized'}
            testID="breakdown-row"
            label={item.name}
            value={formatMoney(item.spent)}
          />
        ))
      )}
      <Divider style={styles.divider} />
      <Row testID="income-row" label="Income" value={formatMoney(income)} />
      {big(uncategorizedIncome.minor) !== 0n ? (
        <Row
          testID="uncategorized-income-row"
          label="Uncategorised income"
          value={formatMoney(uncategorizedIncome)}
        />
      ) : null}
      {fxMissing ? (
        <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
          Some foreign amounts couldn't be converted.
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 8 },
  row: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: 8 },
  label: { flexShrink: 1 },
  value: { flexShrink: 1, textAlign: 'right' },
  divider: { marginVertical: 4 },
});

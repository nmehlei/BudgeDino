import type { TransactionInfo } from '@budgedino/shared';
import { StyleSheet, View } from 'react-native';
import { Text, TouchableRipple } from 'react-native-paper';

import { CategoryIcon } from '../categories/CategoryIcon';
import { formatMoney } from '../format/money';
import { useAppTheme, useSuccessColor } from '../theme';
import { PendingBadge } from './PendingBadge';

interface Props {
  transaction: TransactionInfo;
  categoryName: string | null;
  /** The resolved icon and colour (the list resolves it once, not one hook per row). */
  style: { icon: string; color: string };
  onPress: (id: string) => void;
}

/** Negative amounts keep the neutral text colour, positive ones are green. */
export function useAmountColor(amountMinor: string): string {
  const theme = useAppTheme();
  const success = useSuccessColor();
  // Only strictly positive amounts are green; zero and negative stay neutral.
  return /^[1-9]/.test(amountMinor) ? success : theme.colors.onSurface;
}

export function TransactionRow({ transaction: tx, categoryName, style, onPress }: Props) {
  const theme = useAppTheme();
  const amountColor = useAmountColor(tx.amountMinor);
  const split = tx.splits.length > 0;
  return (
    <TouchableRipple
      onPress={() => onPress(tx.id)}
      accessibilityRole="button"
      testID={`tx-row-${tx.id}`}
      style={styles.row}
    >
      <View style={styles.inner}>
        <CategoryIcon icon={style.icon} color={style.color} size="md" />
        <View style={styles.main}>
          <Text variant="bodyLarge">{tx.counterparty ?? 'Unknown'}</Text>
          <View style={styles.meta}>
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
              {split ? 'Split' : (categoryName ?? 'Uncategorized')}
            </Text>
            {tx.status === 'pending' ? <PendingBadge /> : null}
          </View>
        </View>
        <Text variant="bodyLarge" style={[styles.amount, { color: amountColor }]}>
          {formatMoney({ minor: tx.amountMinor, currency: tx.currency })}
        </Text>
      </View>
    </TouchableRipple>
  );
}

const styles = StyleSheet.create({
  row: { paddingHorizontal: 16, paddingVertical: 10, minHeight: 48 },
  inner: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'space-between' },
  main: { flexShrink: 1, flexGrow: 1, flexBasis: 140, gap: 2 },
  meta: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  amount: { fontVariant: ['tabular-nums'], flexShrink: 0 },
});

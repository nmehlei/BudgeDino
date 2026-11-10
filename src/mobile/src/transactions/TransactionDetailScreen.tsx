import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import {
  ActivityIndicator,
  Button,
  Divider,
  List,
  Snackbar,
  Switch,
  Text,
} from 'react-native-paper';

import { formatMoney } from '../format/money';
import { formatDateHeader } from './group';
import { useAppTheme } from '../theme';
import { PendingBadge } from './PendingBadge';
import {
  categoryNameMap,
  describeWriteError,
  flattenPages,
  useAccounts,
  useCategories,
  useRecategorize,
  useTransactionsList,
} from './queries';
import { ScreenHeader } from './ScreenHeader';
import { useAmountColor } from './TransactionRow';

function Field({ label, value }: { label: string; value: string }) {
  const theme = useAppTheme();
  return (
    <View style={styles.field}>
      <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant }}>
        {label}
      </Text>
      <Text variant="bodyLarge">{value}</Text>
    </View>
  );
}

export function TransactionDetailScreen({ id }: { id: string }) {
  const theme = useAppTheme();
  const list = useTransactionsList();
  const categories = useCategories();
  const accounts = useAccounts();
  const recategorize = useRecategorize();
  const [applyToCounterparty, setApplyToCounterparty] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const tx = useMemo(() => flattenPages(list.data).find((t) => t.id === id), [list.data, id]);
  const names = useMemo(() => categoryNameMap(categories.data), [categories.data]);
  const amountColor = useAmountColor(tx?.amountMinor ?? '0');

  const header = <ScreenHeader title="Transaction" />;

  if (!tx) {
    return (
      <View style={[styles.flex, { backgroundColor: theme.colors.background }]}>
        {header}
        <View style={styles.center} testID={list.isPending ? undefined : 'transaction-missing'}>
          {list.isPending ? (
            <ActivityIndicator animating accessibilityLabel="Loading" />
          ) : (
            <Text variant="bodyMedium">This transaction isn&apos;t available.</Text>
          )}
        </View>
      </View>
    );
  }

  const account = accounts.data?.find((a) => a.id === tx.accountId);
  const counterparty = tx.counterparty?.trim() ? tx.counterparty : null;
  const choices = (categories.data ?? []).filter((c) => !c.archived || c.id === tx.categoryId);

  const pick = (categoryId: string) => {
    if (categoryId === tx.categoryId && !applyToCounterparty) return;
    recategorize.mutate(
      { id: tx.id, categoryId, applyToCounterparty: applyToCounterparty && counterparty !== null },
      {
        onError: (error) => setToast(describeWriteError(error)),
        onSuccess: () => setApplyToCounterparty(false),
      },
    );
  };

  return (
    <View style={[styles.flex, { backgroundColor: theme.colors.background }]}>
      {header}
      <ScrollView contentContainerStyle={styles.content} testID="transaction-detail">
        <Text variant="headlineMedium" style={{ color: amountColor }} testID="detail-amount">
          {formatMoney({ minor: tx.amountMinor, currency: tx.currency })}
        </Text>
        {tx.status === 'pending' ? (
          <View style={styles.badgeRow}>
            <PendingBadge />
          </View>
        ) : null}
        <Field label="Counterparty" value={counterparty ?? 'Unknown'} />
        {tx.purpose ? <Field label="Purpose" value={tx.purpose} /> : null}
        <Field label="Account" value={account?.name ?? 'Account'} />
        <Field label="Booking date" value={formatDateHeader(tx.bookingDate)} />
        <Field
          label="Category"
          value={
            tx.splits.length > 0
              ? 'Split across several categories'
              : tx.categoryId
                ? (names.get(tx.categoryId) ?? 'Unknown category')
                : 'Uncategorized'
          }
        />

        {tx.splits.length === 0 ? (
          <>
            <Divider />
            {counterparty ? (
              <View style={styles.toggle}>
                <View style={styles.toggleInner}>
                  <Text variant="bodyLarge" style={styles.toggleLabel}>
                    Always use this for {counterparty}
                  </Text>
                  <Switch
                    value={applyToCounterparty}
                    onValueChange={setApplyToCounterparty}
                    testID="apply-to-counterparty"
                    accessibilityLabel={`Always use this for ${counterparty}`}
                  />
                </View>
              </View>
            ) : null}
            <Text variant="titleSmall" style={styles.pickerTitle}>
              Choose a category
            </Text>
            {categories.isPending ? (
              <ActivityIndicator animating accessibilityLabel="Loading categories" />
            ) : categories.isError ? (
              <View style={styles.retry} testID="categories-error">
                <Text variant="bodyMedium">The categories couldn&apos;t be loaded.</Text>
                <Button mode="outlined" onPress={() => void categories.refetch()}>
                  Retry
                </Button>
              </View>
            ) : choices.length === 0 ? (
              <Text variant="bodyMedium">No categories available.</Text>
            ) : (
              choices.map((c) => (
                <List.Item
                  key={c.id}
                  title={c.name}
                  titleNumberOfLines={0}
                  description={c.group ?? undefined}
                  descriptionNumberOfLines={0}
                  onPress={() => pick(c.id)}
                  testID={`category-${c.id}`}
                  accessibilityState={{ selected: c.id === tx.categoryId }}
                  right={(p) => (c.id === tx.categoryId ? <List.Icon {...p} icon="check" /> : null)}
                />
              ))
            )}
          </>
        ) : null}
      </ScrollView>
      <Snackbar visible={toast !== null} onDismiss={() => setToast(null)} duration={5000}>
        {toast ?? ''}
      </Snackbar>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  content: { padding: 16, gap: 14, paddingBottom: 48 },
  badgeRow: { flexDirection: 'row' },
  field: { gap: 2 },
  toggle: { paddingVertical: 8 },
  toggleInner: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  toggleLabel: { flex: 1 },
  retry: { gap: 8, alignItems: 'flex-start' },
  pickerTitle: { marginTop: 8 },
});

import type { AccountInfo } from '@budgedino/shared';
import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { ActivityIndicator, Button, Divider, Snackbar, Switch, Text } from 'react-native-paper';

import { formatMoney } from '../format/money';
import { useAppTheme } from '../theme';
import { describeWriteError, useAccounts, useUpdateAccount } from './queries';
import { ScreenHeader } from './ScreenHeader';

function ToggleRow({
  label,
  value,
  disabled,
  onChange,
  testID,
}: {
  label: string;
  value: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
  testID: string;
}) {
  return (
    <View style={styles.toggle}>
      <Text variant="bodyLarge" style={styles.toggleLabel}>
        {label}
      </Text>
      <Switch
        value={value}
        disabled={disabled}
        onValueChange={onChange}
        testID={testID}
        accessibilityLabel={label}
      />
    </View>
  );
}

function AccountCard({
  account,
  busy,
  onPatch,
}: {
  account: AccountInfo;
  busy: boolean;
  onPatch: (
    id: string,
    patch: { visibility?: AccountInfo['visibility']; countsTowardBudgets?: boolean },
  ) => void;
}) {
  const theme = useAppTheme();
  return (
    <View style={styles.card} testID={`account-${account.id}`}>
      <Text variant="titleMedium">{account.name}</Text>
      {account.ibanMasked ? (
        <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
          {account.ibanMasked}
        </Text>
      ) : null}
      {account.balanceMinor !== null ? (
        <Text variant="bodyMedium">
          {formatMoney({ minor: account.balanceMinor, currency: account.currency })}
        </Text>
      ) : null}
      {account.isOwner ? (
        <>
          <ToggleRow
            label="Private (only me)"
            value={account.visibility === 'owner_only'}
            disabled={busy}
            testID={`private-${account.id}`}
            onChange={(on) => onPatch(account.id, { visibility: on ? 'owner_only' : 'household' })}
          />
          <ToggleRow
            label="Counts toward budgets"
            value={account.countsTowardBudgets}
            disabled={busy}
            testID={`counts-${account.id}`}
            onChange={(on) => onPatch(account.id, { countsTowardBudgets: on })}
          />
        </>
      ) : (
        <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
          Shared by another member
        </Text>
      )}
    </View>
  );
}

export function AccountsScreen() {
  const theme = useAppTheme();
  const accounts = useAccounts();
  const update = useUpdateAccount();
  const [toast, setToast] = useState<string | null>(null);
  const pendingId = update.isPending ? update.variables.id : null;

  const patch = (id: string, change: Parameters<typeof update.mutate>[0]['patch']) =>
    update.mutate(
      { id, patch: change },
      { onError: (error) => setToast(describeWriteError(error)) },
    );

  let body;
  if (accounts.data) {
    body =
      accounts.data.length === 0 ? (
        <Text variant="bodyMedium">No accounts yet.</Text>
      ) : (
        accounts.data.map((a, i) => (
          <View key={a.id}>
            {i > 0 ? <Divider /> : null}
            <AccountCard account={a} busy={pendingId === a.id} onPatch={patch} />
          </View>
        ))
      );
  } else if (accounts.isError) {
    body = (
      <View style={styles.message} testID="accounts-error">
        <Text variant="bodyMedium">The accounts couldn&apos;t be loaded.</Text>
        <Button mode="contained" onPress={() => void accounts.refetch()}>
          Retry
        </Button>
      </View>
    );
  } else {
    body = <ActivityIndicator animating accessibilityLabel="Loading" />;
  }

  return (
    <View style={[styles.flex, { backgroundColor: theme.colors.background }]}>
      <ScreenHeader title="Accounts" />
      <ScrollView contentContainerStyle={styles.content}>{body}</ScrollView>
      <Snackbar visible={toast !== null} onDismiss={() => setToast(null)} duration={5000}>
        {toast ?? ''}
      </Snackbar>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: 16, gap: 12, paddingBottom: 48 },
  card: { paddingVertical: 12, gap: 6 },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48 },
  toggleLabel: { flex: 1 },
  message: { gap: 12, alignItems: 'flex-start' },
});

import type { BudgetView } from '@budgedino/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import {
  ActivityIndicator,
  Button,
  Dialog,
  Divider,
  FAB,
  IconButton,
  List,
  Portal,
  Snackbar,
  Text,
} from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useApi } from '../api/useApi';
import { formatMoney } from '../format/money';
import { useIsAdmin } from '../household/queries';
import { SettingsPage } from '../settings/SettingsPage';
import { useAppTheme } from '../theme';
import { budgetsKey, describeBudgetError, useBudgets } from './queries';

export const PERIOD_LABEL = { weekly: 'Weekly', monthly: 'Monthly' } as const;

export function BudgetsScreen() {
  const theme = useAppTheme();
  const router = useRouter();
  const api = useApi();
  const client = useQueryClient();
  const insets = useSafeAreaInsets();
  const isAdmin = useIsAdmin();
  const budgets = useBudgets();
  const [deleting, setDeleting] = useState<BudgetView | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const remove = async (budget: BudgetView) => {
    setBusy(true);
    try {
      await api.archiveBudget(budget.id);
      setToast('Budget deleted');
    } catch (error) {
      setToast(describeBudgetError(error, "Couldn't delete the budget."));
    } finally {
      setBusy(false);
      setDeleting(null);
      void client.invalidateQueries({ queryKey: budgetsKey });
      void client.invalidateQueries({ queryKey: ['home'] });
    }
  };

  let body;
  if (budgets.data) {
    body =
      budgets.data.length === 0 ? (
        <Text variant="bodyMedium" style={styles.pad}>
          {isAdmin ? 'No budgets yet. Tap "New budget" to add one.' : 'No budgets yet.'}
        </Text>
      ) : (
        <>
          {budgets.data.map((b, i) => (
            <View key={b.id}>
              {i > 0 ? <Divider /> : null}
              <List.Item
                testID={`budget-${b.id}`}
                title={b.name}
                titleNumberOfLines={0}
                description={`${PERIOD_LABEL[b.periodKind]} · ${formatMoney(b.amount)}`}
                descriptionNumberOfLines={0}
                descriptionStyle={{ color: theme.colors.onSurfaceVariant }}
                onPress={isAdmin ? () => router.push(`/more/budgets/${b.id}`) : undefined}
                right={
                  isAdmin
                    ? () => (
                        <IconButton
                          icon="trash-can-outline"
                          accessibilityLabel={`Delete ${b.name}`}
                          onPress={() => setDeleting(b)}
                          testID={`delete-budget-${b.id}`}
                        />
                      )
                    : undefined
                }
              />
            </View>
          ))}
          {!isAdmin ? (
            <Text
              variant="bodySmall"
              style={[styles.pad, styles.hint, { color: theme.colors.onSurfaceVariant }]}
              testID="budgets-readonly"
            >
              Only admins can change budgets.
            </Text>
          ) : null}
        </>
      );
  } else if (budgets.isError) {
    body = (
      <View style={[styles.message, styles.pad]} testID="budgets-error">
        <Text variant="bodyMedium">The budgets couldn&apos;t be loaded.</Text>
        <Button mode="contained" onPress={() => void budgets.refetch()}>
          Retry
        </Button>
      </View>
    );
  } else {
    body = <ActivityIndicator animating accessibilityLabel="Loading" />;
  }

  return (
    <SettingsPage
      title="Budgets"
      overlay={
        <>
          {isAdmin ? (
            <FAB
              icon="plus"
              label="New budget"
              onPress={() => router.push('/more/budgets/new')}
              style={[styles.fab, { right: 16 + insets.right, bottom: 16 }]}
              testID="add-budget"
            />
          ) : null}
          <Portal>
            {deleting ? (
              <Dialog
                visible
                onDismiss={() => !busy && setDeleting(null)}
                testID="delete-budget-dialog"
              >
                <Dialog.Title>Delete budget?</Dialog.Title>
                <Dialog.Content>
                  <Text variant="bodyMedium">
                    {`"${deleting.name}" will no longer be tracked. Your transactions are not affected.`}
                  </Text>
                </Dialog.Content>
                <Dialog.Actions>
                  <Button onPress={() => setDeleting(null)} testID="delete-budget-cancel">
                    Cancel
                  </Button>
                  <Button
                    onPress={() => void remove(deleting)}
                    disabled={busy}
                    loading={busy}
                    textColor={theme.colors.error}
                    testID="delete-budget-confirm"
                  >
                    Delete
                  </Button>
                </Dialog.Actions>
              </Dialog>
            ) : null}
          </Portal>
          <Snackbar visible={toast !== null} onDismiss={() => setToast(null)} duration={5000}>
            {toast ?? ''}
          </Snackbar>
        </>
      }
    >
      {body}
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  pad: { paddingHorizontal: 16 },
  hint: { marginTop: 16 },
  message: { gap: 12, alignItems: 'flex-start' },
  fab: { position: 'absolute' },
});

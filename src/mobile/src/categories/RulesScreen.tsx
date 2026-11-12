import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import {
  ActivityIndicator,
  Button,
  Dialog,
  Divider,
  IconButton,
  List,
  Portal,
  Snackbar,
  Text,
} from 'react-native-paper';

import { useApi } from '../api/useApi';
import { useCategories } from '../budgets/queries';
import { SettingsPage } from '../settings/SettingsPage';
import { useAppTheme } from '../theme';
import { rulesKey } from './keys';
import { describeCategoryError, useRules } from './queries';

/** The caller's own auto-categorization rules, deletable after a confirmation. Match values are never logged. */
export function RulesScreen() {
  const theme = useAppTheme();
  const api = useApi();
  const client = useQueryClient();
  const rules = useRules();
  // Archived categories still name rules, so they must resolve here.
  const categories = useCategories({ includeArchived: true });
  const [confirm, setConfirm] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const nameOf = (id: string) =>
    categories.data?.find((c) => c.id === id)?.name ?? 'Unknown category';

  const remove = async (id: string) => {
    setDeleting(id);
    try {
      await api.deleteRule(id);
      setToast('Rule deleted');
    } catch (error) {
      setToast(describeCategoryError(error, "Couldn't delete the rule."));
    } finally {
      setDeleting(null);
      void client.invalidateQueries({ queryKey: rulesKey });
    }
  };

  let body;
  if (rules.data) {
    body = (
      <>
        <Text
          variant="bodySmall"
          style={[styles.pad, { color: theme.colors.onSurfaceVariant }]}
          testID="rules-explainer"
        >
          Rules categorize new transactions automatically. Deleting a rule does not change past
          transactions: they keep their category.
        </Text>
        {rules.data.length === 0 ? (
          <Text
            variant="bodyMedium"
            style={[styles.pad, styles.top, { color: theme.colors.onSurfaceVariant }]}
          >
            No rules yet. Choose &quot;Always use this&quot; when you categorize a transaction to
            create one.
          </Text>
        ) : (
          rules.data.map((r, i) => (
            <View key={r.id}>
              {i > 0 ? <Divider /> : null}
              <List.Item
                testID={`rule-${r.id}`}
                title={`${r.match.value} → ${nameOf(r.categoryId)}`}
                titleNumberOfLines={0}
                description={
                  r.match.kind === 'iban' ? 'Matches the IBAN' : 'Matches the payee name'
                }
                descriptionNumberOfLines={0}
                descriptionStyle={{ color: theme.colors.onSurfaceVariant }}
                right={() => (
                  <IconButton
                    icon="delete-outline"
                    accessibilityLabel={`Delete rule ${r.match.value}`}
                    disabled={deleting === r.id}
                    onPress={() => setConfirm(r.id)}
                    testID={`delete-rule-${r.id}`}
                  />
                )}
              />
            </View>
          ))
        )}
      </>
    );
  } else if (rules.isError) {
    body = (
      <View style={[styles.message, styles.pad]} testID="rules-error">
        <Text variant="bodyMedium">The rules couldn&apos;t be loaded.</Text>
        <Button mode="contained" onPress={() => void rules.refetch()}>
          Retry
        </Button>
      </View>
    );
  } else {
    body = <ActivityIndicator animating accessibilityLabel="Loading" />;
  }

  return (
    <SettingsPage
      title="Rules"
      overlay={
        <>
          <Portal>
            {confirm ? (
              <Dialog visible onDismiss={() => setConfirm(null)} testID="rule-delete-dialog">
                <Dialog.Title>Delete rule?</Dialog.Title>
                <Dialog.ScrollArea style={styles.dialogScroll}>
                  <ScrollView>
                    <Text variant="bodyMedium" style={styles.dialogText}>
                      New transactions will no longer be categorized by this rule. Past transactions
                      keep their category.
                    </Text>
                  </ScrollView>
                </Dialog.ScrollArea>
                <Dialog.Actions>
                  <Button onPress={() => setConfirm(null)} testID="rule-delete-cancel">
                    Cancel
                  </Button>
                  <Button
                    textColor={theme.colors.error}
                    onPress={() => {
                      const id = confirm;
                      setConfirm(null);
                      void remove(id);
                    }}
                    testID="rule-delete-confirm"
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
  top: { marginTop: 16 },
  message: { gap: 12, alignItems: 'flex-start' },
  dialogScroll: { maxHeight: 240, paddingHorizontal: 0 },
  dialogText: { paddingHorizontal: 24 },
});

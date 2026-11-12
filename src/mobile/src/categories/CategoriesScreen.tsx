import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
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
  Switch,
  Text,
  TextInput,
} from 'react-native-paper';
import {
  resolveCategoryStyle,
  type CategoryInfo,
  type PatchCategoryRequest,
} from '@budgedino/shared';

import { isApiClientError } from '../api/errors';
import { useApi } from '../api/useApi';
import { budgetsKey, categoriesKey, useCategories } from '../budgets/queries';
import { useMembers } from '../household/queries';
import { SettingsPage } from '../settings/SettingsPage';
import { useAppTheme } from '../theme';
import { txKeys } from '../transactions/keys';
import { CategoryIcon } from './CategoryIcon';
import { describeCategoryError } from './queries';
import { StylePicker, type CategoryStyleValue } from './StylePicker';
import { useCategoryStyleById } from './useCategoryStyle';

const NO_GROUP = 'No group';
const DEFAULT_STYLE: CategoryStyleValue = { icon: 'tag', color: 'slate' };

type Editing = { mode: 'create' } | { mode: 'edit'; category: CategoryInfo };

function groupCategories(list: CategoryInfo[]): { group: string; items: CategoryInfo[] }[] {
  const byGroup = new Map<string, CategoryInfo[]>();
  for (const c of list) {
    const key = c.group ?? NO_GROUP;
    byGroup.set(key, [...(byGroup.get(key) ?? []), c]);
  }
  return [...byGroup.entries()]
    .sort(([a], [b]) => {
      if (a === NO_GROUP) return 1;
      if (b === NO_GROUP) return -1;
      return a.localeCompare(b);
    })
    .map(([group, items]) => ({
      group,
      items: [...items].sort((a, b) => a.name.localeCompare(b.name)),
    }));
}

/** Categories grouped by `group`, archived ones collapsed. Admins add, rename, regroup and archive; members read. */
export function CategoriesScreen() {
  const theme = useAppTheme();
  const api = useApi();
  const router = useRouter();
  const client = useQueryClient();
  const members = useMembers();
  const isAdmin = members.data?.find((m) => m.isSelf)?.role === 'admin';
  const categories = useCategories({ includeArchived: true });
  const [editing, setEditing] = useState<Editing | null>(null);
  const [name, setName] = useState('');
  const [group, setGroup] = useState('');
  const [isIncome, setIsIncome] = useState(false);
  const [style, setStyle] = useState<CategoryStyleValue>(DEFAULT_STYLE);
  const styleOf = useCategoryStyleById();
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [archivedClash, setArchivedClash] = useState<CategoryInfo | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const refresh = () => {
    void client.invalidateQueries({ queryKey: categoriesKey });
    // Screens that show category names.
    void client.invalidateQueries({ queryKey: budgetsKey });
    void client.invalidateQueries({ queryKey: ['home'] });
    void client.invalidateQueries({ queryKey: txKeys.all });
  };

  const openDialog = (next: Editing) => {
    setEditing(next);
    setName(next.mode === 'edit' ? next.category.name : '');
    setGroup(next.mode === 'edit' ? (next.category.group ?? '') : '');
    setIsIncome(false);
    setStyle(next.mode === 'edit' ? resolveCategoryStyle(next.category) : DEFAULT_STYLE);
    setFormError(null);
    setArchivedClash(null);
  };

  const setArchived = async (category: CategoryInfo, archived: boolean) => {
    setBusy(category.id);
    try {
      await api.patchCategory(category.id, { archived });
      setToast(archived ? `Archived ${category.name}` : `Unarchived ${category.name}`);
    } catch (error) {
      setToast(describeCategoryError(error, "Couldn't change the category."));
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const save = async () => {
    if (!editing) return;
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > 40) {
      setFormError('Enter a name of 1 to 40 characters.');
      return;
    }
    const trimmedGroup = group.trim();
    if (trimmedGroup.length > 40) {
      setFormError('The group can have at most 40 characters.');
      return;
    }
    setSaving(true);
    setFormError(null);
    setArchivedClash(null);
    try {
      if (editing.mode === 'create') {
        await api.createCategory({
          name: trimmed,
          ...(trimmedGroup ? { group: trimmedGroup } : {}),
          isIncome,
          icon: style.icon,
          color: style.color,
        });
      } else {
        const { category } = editing;
        const body: PatchCategoryRequest = {};
        const stored = resolveCategoryStyle(category);
        if (style.icon !== stored.icon) body.icon = style.icon;
        if (style.color !== stored.color) body.color = style.color;
        if (trimmed !== category.name) body.name = trimmed;
        // An empty string clears the group (`null` is rejected by the server).
        if (trimmedGroup !== (category.group ?? '')) body.group = trimmedGroup;
        if (Object.keys(body).length > 0) {
          await api.patchCategory(category.id, body);
        }
      }
      setEditing(null);
      refresh();
    } catch (error) {
      if (isApiClientError(error) && error.error.kind === 'server' && error.error.status === 409) {
        setFormError('A category with this name exists.');
        // Archived categories still reserve their name: point at the one to unarchive.
        const lower = trimmed.toLocaleLowerCase('de-DE');
        setArchivedClash(
          categories.data?.find((c) => c.archived && c.name.toLocaleLowerCase('de-DE') === lower) ??
            null,
        );
      } else {
        setFormError(describeCategoryError(error, "Couldn't save the category."));
      }
    } finally {
      setSaving(false);
    }
  };

  const unarchiveClash = async () => {
    if (!archivedClash) return;
    const target = archivedClash;
    setEditing(null);
    await setArchived(target, false);
  };

  const row = (c: CategoryInfo) => {
    const description = [c.isIncome ? 'Income' : null, c.isTransfer ? 'Not budgeted' : null]
      .filter((p) => p !== null)
      .join(' · ');
    // The Transfer category is fixed: no actions at all.
    const actions = isAdmin && !c.isTransfer;
    return (
      <View key={c.id}>
        <List.Item
          testID={`category-${c.id}`}
          title={c.name}
          titleNumberOfLines={0}
          description={description || undefined}
          descriptionNumberOfLines={0}
          left={() => {
            const s = styleOf(c.id);
            return (
              <View style={styles.leftIcon}>
                <CategoryIcon icon={s.icon} color={s.color} size="md" />
              </View>
            );
          }}
          descriptionStyle={{ color: theme.colors.onSurfaceVariant }}
          right={
            actions
              ? () => (
                  <View style={styles.actions}>
                    {c.archived ? null : (
                      <IconButton
                        icon="pencil-outline"
                        accessibilityLabel={`Edit ${c.name}`}
                        onPress={() => openDialog({ mode: 'edit', category: c })}
                        testID={`edit-category-${c.id}`}
                      />
                    )}
                    <IconButton
                      icon={c.archived ? 'archive-arrow-up-outline' : 'archive-outline'}
                      accessibilityLabel={`${c.archived ? 'Unarchive' : 'Archive'} ${c.name}`}
                      disabled={busy === c.id}
                      onPress={() => void setArchived(c, !c.archived)}
                      testID={`${c.archived ? 'unarchive' : 'archive'}-category-${c.id}`}
                    />
                  </View>
                )
              : undefined
          }
        />
      </View>
    );
  };

  let body;
  if (members.isError) {
    // Never treat a failed lookup as "not an admin": say so and let the user retry.
    body = (
      <View style={[styles.message, styles.pad]} testID="categories-error">
        <Text variant="bodyMedium">The household couldn&apos;t be loaded.</Text>
        <Button mode="contained" onPress={() => void members.refetch()}>
          Retry
        </Button>
      </View>
    );
  } else if (categories.data && members.data) {
    const active = categories.data.filter((c) => !c.archived);
    const archived = categories.data.filter((c) => c.archived);
    body = (
      <>
        <List.Item
          title="Rules"
          description="Automatic categorization you set up"
          descriptionNumberOfLines={0}
          left={(p) => <List.Icon {...p} icon="auto-fix" />}
          right={(p) => <List.Icon {...p} icon="chevron-right" />}
          onPress={() => router.push('/more/categories/rules')}
          testID="open-rules"
        />
        <Divider />
        {isAdmin ? (
          <Button
            mode="contained"
            icon="plus"
            onPress={() => openDialog({ mode: 'create' })}
            style={styles.addButton}
            testID="add-category"
          >
            Add category
          </Button>
        ) : (
          <Text
            variant="bodySmall"
            style={[styles.pad, styles.top, { color: theme.colors.onSurfaceVariant }]}
            testID="categories-readonly"
          >
            Only admins can change categories.
          </Text>
        )}
        {groupCategories(active).map(({ group: g, items }) => (
          <View key={g}>
            <List.Subheader>{g}</List.Subheader>
            {items.map(row)}
          </View>
        ))}
        {archived.length > 0 ? (
          <List.Accordion
            title={`Archived (${String(archived.length)})`}
            description="Hidden from pickers, kept on old transactions"
            descriptionNumberOfLines={0}
            testID="archived-section"
          >
            {archived.map(row)}
          </List.Accordion>
        ) : null}
      </>
    );
  } else if (categories.isError) {
    body = (
      <View style={[styles.message, styles.pad]} testID="categories-load-error">
        <Text variant="bodyMedium">The categories couldn&apos;t be loaded.</Text>
        <Button mode="contained" onPress={() => void categories.refetch()}>
          Retry
        </Button>
      </View>
    );
  } else {
    body = <ActivityIndicator animating accessibilityLabel="Loading" />;
  }

  return (
    <SettingsPage
      title="Categories"
      overlay={
        <>
          <Portal>
            {editing ? (
              <Dialog visible onDismiss={() => setEditing(null)} testID="category-dialog">
                <Dialog.Title>
                  {editing.mode === 'create' ? 'Add category' : 'Edit category'}
                </Dialog.Title>
                <Dialog.ScrollArea style={styles.dialogScroll}>
                  <ScrollView keyboardShouldPersistTaps="handled">
                    <View style={styles.form}>
                      <TextInput
                        mode="outlined"
                        label="Name"
                        value={name}
                        onChangeText={setName}
                        maxLength={80}
                        autoFocus
                        testID="category-name"
                      />
                      <TextInput
                        mode="outlined"
                        label="Group (optional)"
                        value={group}
                        onChangeText={setGroup}
                        maxLength={80}
                        testID="category-group"
                      />
                      {editing.mode === 'create' ? (
                        <View style={styles.switchRow}>
                          <Text variant="bodyLarge" style={styles.flex}>
                            Income category
                          </Text>
                          <Switch
                            value={isIncome}
                            onValueChange={setIsIncome}
                            accessibilityLabel="Income category"
                            testID="category-income"
                          />
                        </View>
                      ) : null}
                      <StylePicker value={style} onChange={setStyle} />
                      {formError ? (
                        <Text
                          variant="bodyMedium"
                          style={{ color: theme.colors.error }}
                          testID="category-error"
                        >
                          {formError}
                        </Text>
                      ) : null}
                      {archivedClash ? (
                        <View style={styles.message}>
                          <Text variant="bodyMedium">
                            It is archived: unarchive it instead of creating a new one.
                          </Text>
                          <Button
                            mode="outlined"
                            onPress={() => void unarchiveClash()}
                            testID="unarchive-existing"
                          >
                            {`Unarchive ${archivedClash.name}`}
                          </Button>
                        </View>
                      ) : null}
                    </View>
                  </ScrollView>
                </Dialog.ScrollArea>
                <Dialog.Actions>
                  <Button onPress={() => setEditing(null)} testID="category-cancel">
                    Cancel
                  </Button>
                  <Button
                    onPress={() => void save()}
                    loading={saving}
                    disabled={saving}
                    testID="category-save"
                  >
                    Save
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
  flex: { flex: 1 },
  pad: { paddingHorizontal: 16 },
  top: { marginTop: 16 },
  addButton: { margin: 16, alignSelf: 'flex-start' },
  message: { gap: 12, alignItems: 'flex-start' },
  leftIcon: { justifyContent: 'center', paddingLeft: 8 },
  actions: { flexDirection: 'row', alignItems: 'center' },
  dialogScroll: { maxHeight: 360, paddingHorizontal: 0 },
  form: { gap: 12, paddingHorizontal: 24, paddingVertical: 8 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
});

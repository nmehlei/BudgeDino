import type { ConnectorInfo } from '@budgedino/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import {
  ActivityIndicator,
  Button,
  Dialog,
  Divider,
  FAB,
  Icon,
  IconButton,
  List,
  Menu,
  Portal,
  Snackbar,
  Text,
  TextInput,
} from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useApi } from '../api/useApi';
import { formatDate, formatRelative } from '../format/time';
import { netWorthKey } from '../net-worth/queries';
import { accountsKey, txKeys } from '../transactions/queries';
import { useAppTheme } from '../theme';
import { BankAvatar } from './BankAvatar';
import { connectorTitle } from './banks';
import { challengeStore } from './challenge-store';
import { connectorsKey, describeActionError, useConnectors } from './queries';
import { WrappingButton } from './WrappingButton';

const STATUS_LABEL: Record<ConnectorInfo['status'], string> = {
  ok: 'Connected',
  needs_attention: 'Needs attention',
  error: 'Error',
  disabled: 'Disabled',
};

const NAME_MAX = 60;

function consentText(iso: string | null, now: number): string | null {
  if (!iso) return null;
  return Date.parse(iso) <= now
    ? `Consent expired ${formatDate(iso)}`
    : `Consent valid until ${formatDate(iso)}`;
}

/** Which menu entries a connection offers; `disabled` ones can only be renamed or deleted. */
export function menuActions(status: ConnectorInfo['status']): {
  sync: boolean;
  reconnect: boolean;
} {
  return {
    sync: status === 'ok' || status === 'error',
    reconnect: status === 'needs_attention' || status === 'error',
  };
}

interface RowProps {
  connector: ConnectorInfo;
  busy: boolean;
  onSync: (id: string) => void;
  onReconnect: (id: string) => void;
  onRename: (connector: ConnectorInfo) => void;
  onDelete: (connector: ConnectorInfo) => void;
}

function StatusIndicator({ connector: c }: { connector: ConnectorInfo }) {
  const theme = useAppTheme();
  const bad = c.status === 'needs_attention' || c.status === 'error';
  const icon = bad
    ? 'alert-circle-outline'
    : c.status === 'ok'
      ? 'check-circle-outline'
      : 'minus-circle-outline';
  const color = bad
    ? theme.colors.error
    : c.status === 'ok'
      ? theme.colors.primary
      : theme.colors.onSurfaceVariant;
  return (
    <View
      accessible
      accessibilityLabel={STATUS_LABEL[c.status]}
      testID={`connector-status-${c.id}`}
      style={styles.status}
    >
      <Icon source={icon} size={24} color={color} />
    </View>
  );
}

function ConnectorRow({ connector: c, busy, onSync, onReconnect, onRename, onDelete }: RowProps) {
  const theme = useAppTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  const now = Date.now();
  const actions = menuActions(c.status);
  const consent = c.isOwner ? consentText(c.consentExpiresAt, now) : null;
  const lines = [
    `${STATUS_LABEL[c.status]} · ${
      c.lastSuccessAt ? `Last sync ${formatRelative(c.lastSuccessAt, now)}` : 'Never synced'
    }`,
    ...(consent ? [consent] : []),
    ...(c.isOwner ? [] : ['Shared by another member']),
  ];
  const run = (fn: () => void) => () => {
    setMenuOpen(false);
    fn();
  };
  return (
    <List.Item
      testID={`connector-${c.id}`}
      title={connectorTitle(c)}
      titleNumberOfLines={0}
      description={lines.join('\n')}
      descriptionNumberOfLines={0}
      descriptionStyle={{ color: theme.colors.onSurfaceVariant }}
      left={() => (
        <View style={styles.avatar}>
          <BankAvatar bank={c.bank} />
        </View>
      )}
      right={() => (
        <View style={styles.right}>
          <StatusIndicator connector={c} />
          {c.isOwner ? (
            <Menu
              visible={menuOpen}
              onDismiss={() => setMenuOpen(false)}
              anchor={
                <IconButton
                  icon="dots-vertical"
                  onPress={() => setMenuOpen(true)}
                  accessibilityLabel={`Actions for ${connectorTitle(c)}`}
                  testID={`menu-${c.id}`}
                />
              }
            >
              {actions.sync ? (
                <Menu.Item
                  leadingIcon="sync"
                  title="Sync now"
                  disabled={busy}
                  onPress={run(() => onSync(c.id))}
                  testID={`sync-${c.id}`}
                />
              ) : null}
              {actions.reconnect ? (
                <Menu.Item
                  leadingIcon="link-variant"
                  title="Reconnect"
                  disabled={busy}
                  onPress={run(() => onReconnect(c.id))}
                  testID={`reconnect-${c.id}`}
                />
              ) : null}
              <Menu.Item
                leadingIcon="pencil-outline"
                title="Rename"
                onPress={run(() => onRename(c))}
                testID={`rename-${c.id}`}
              />
              <Menu.Item
                leadingIcon="trash-can-outline"
                title="Delete"
                onPress={run(() => onDelete(c))}
                testID={`delete-${c.id}`}
              />
            </Menu>
          ) : null}
        </View>
      )}
    />
  );
}

function RenameDialog({
  connector,
  busy,
  onCancel,
  onSave,
}: {
  connector: ConnectorInfo;
  busy: boolean;
  onCancel: () => void;
  onSave: (name: string | null) => void;
}) {
  const [name, setName] = useState(connectorTitle(connector));
  const trimmed = name.trim();
  return (
    <Dialog visible onDismiss={onCancel} testID="rename-dialog">
      <Dialog.Title>Rename connection</Dialog.Title>
      <Dialog.Content>
        <TextInput
          mode="outlined"
          label="Name"
          value={name}
          onChangeText={setName}
          maxLength={NAME_MAX}
          autoFocus
          testID="rename-input"
        />
        <Text variant="bodySmall" style={styles.hint}>
          Leave it empty to use the bank name again.
        </Text>
      </Dialog.Content>
      <Dialog.Actions>
        <Button onPress={onCancel} testID="rename-cancel">
          Cancel
        </Button>
        <Button
          onPress={() => onSave(trimmed === '' ? null : trimmed)}
          disabled={busy}
          loading={busy}
          testID="rename-save"
        >
          Save
        </Button>
      </Dialog.Actions>
    </Dialog>
  );
}

function DeleteDialog({
  connector,
  confirmPurge,
  busy,
  onKeep,
  onAskPurge,
  onPurge,
  onCancel,
}: {
  connector: ConnectorInfo;
  confirmPurge: boolean;
  busy: boolean;
  onKeep: () => void;
  onAskPurge: () => void;
  onPurge: () => void;
  onCancel: () => void;
}) {
  const theme = useAppTheme();
  const title = connectorTitle(connector);
  if (confirmPurge) {
    return (
      <Dialog visible onDismiss={onCancel} testID="purge-dialog">
        <Dialog.Title>Delete everything?</Dialog.Title>
        <Dialog.Content style={styles.dialogContent}>
          <Text variant="bodyMedium">
            {`This permanently deletes ${title} with its accounts, transactions and balances. This can't be undone.`}
          </Text>
          <WrappingButton
            destructive
            onPress={onPurge}
            disabled={busy}
            loading={busy}
            testID="purge-confirm"
          >
            Delete everything
          </WrappingButton>
          <WrappingButton mode="text" onPress={onCancel} testID="purge-cancel">
            Cancel
          </WrappingButton>
        </Dialog.Content>
      </Dialog>
    );
  }
  return (
    <Dialog visible onDismiss={onCancel} testID="delete-dialog">
      <Dialog.Title>Remove connection</Dialog.Title>
      <Dialog.Content style={styles.dialogContent}>
        <Text variant="bodyMedium">{`What should happen to the data of ${title}?`}</Text>
        <WrappingButton onPress={onKeep} disabled={busy} loading={busy} testID="delete-keep">
          Remove connection, keep history
        </WrappingButton>
        <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
          Accounts and transactions stay and keep counting toward budgets.
        </Text>
        <WrappingButton
          mode="text"
          destructive
          onPress={onAskPurge}
          disabled={busy}
          testID="delete-purge"
        >
          Delete connection and all its data
        </WrappingButton>
        <WrappingButton mode="text" onPress={onCancel} testID="delete-cancel">
          Cancel
        </WrappingButton>
      </Dialog.Content>
    </Dialog>
  );
}

export function ConnectionsScreen() {
  const theme = useAppTheme();
  const router = useRouter();
  const api = useApi();
  const client = useQueryClient();
  const insets = useSafeAreaInsets();
  const connectors = useConnectors();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<ConnectorInfo | null>(null);
  const [deleting, setDeleting] = useState<{ connector: ConnectorInfo; confirm: boolean } | null>(
    null,
  );
  const [dialogBusy, setDialogBusy] = useState(false);

  // Both actions are user-present: the user just tapped, so the bank dialog may be started.
  const sync = async (id: string) => {
    setBusyId(id);
    try {
      await api.syncConnector(id);
      setToast('Sync started');
      void client.invalidateQueries({ queryKey: connectorsKey });
      void client.invalidateQueries({ queryKey: ['home'] });
    } catch (error) {
      setToast(describeActionError(error, "Couldn't start the sync."));
    } finally {
      setBusyId(null);
    }
  };

  const reconnect = async (id: string) => {
    setBusyId(id);
    try {
      const res = await api.reconnectConnector(id);
      if (res.challenge) {
        challengeStore.set({ view: res.challenge, connectorId: id });
        router.push(`/connections/challenge/${res.challenge.id}`);
      } else {
        setToast('Reconnected');
        void client.invalidateQueries({ queryKey: connectorsKey });
      }
    } catch (error) {
      setToast(describeActionError(error, "Couldn't reconnect."));
    } finally {
      setBusyId(null);
    }
  };

  const rename = async (connector: ConnectorInfo, name: string | null) => {
    setDialogBusy(true);
    try {
      await api.renameConnector(connector.id, name);
      setRenaming(null);
      void client.invalidateQueries({ queryKey: connectorsKey });
      void client.invalidateQueries({ queryKey: ['home'] }); // the sync chips carry the name
    } catch (error) {
      setRenaming(null);
      setToast(describeActionError(error, "Couldn't rename the connection."));
    } finally {
      setDialogBusy(false);
    }
  };

  const remove = async (connector: ConnectorInfo, mode: 'keep' | 'purge') => {
    setDialogBusy(true);
    try {
      await api.deleteConnector(connector.id, mode);
      setDeleting(null);
      setToast(mode === 'keep' ? 'Connection removed, history kept' : 'Connection deleted');
    } catch (error) {
      setDeleting(null);
      setToast(describeActionError(error, "Couldn't remove the connection."));
    } finally {
      setDialogBusy(false);
      // A purge can have removed accounts and transactions even when the answer got lost: always refetch.
      for (const queryKey of [
        connectorsKey,
        ['home'],
        txKeys.all,
        accountsKey,
        netWorthKey,
      ] as const) {
        void client.invalidateQueries({ queryKey });
      }
    }
  };

  const own = (connectors.data ?? []).filter((c) => c.isOwner);
  const others = (connectors.data ?? []).filter((c) => !c.isOwner);

  const rows = (list: ConnectorInfo[]) =>
    list.map((c, i) => (
      <View key={c.id}>
        {i > 0 ? <Divider /> : null}
        <ConnectorRow
          connector={c}
          busy={busyId === c.id}
          onSync={sync}
          onReconnect={reconnect}
          onRename={setRenaming}
          onDelete={(connector) => setDeleting({ connector, confirm: false })}
        />
      </View>
    ));

  let body;
  if (connectors.data) {
    body = (
      <>
        {own.length === 0 ? (
          <Text variant="bodyMedium" style={styles.pad}>
            No bank connected yet.
          </Text>
        ) : (
          rows(own)
        )}
        {others.length > 0 ? (
          <>
            <Text variant="titleSmall" style={[styles.pad, styles.section]}>
              Shared by others
            </Text>
            {rows(others)}
          </>
        ) : null}
      </>
    );
  } else if (connectors.isError) {
    body = (
      <View style={[styles.message, styles.pad]} testID="connections-error">
        <Text variant="bodyMedium">The connections couldn&apos;t be loaded.</Text>
        <Button mode="contained" onPress={() => void connectors.refetch()}>
          Retry
        </Button>
      </View>
    );
  } else {
    body = <ActivityIndicator animating accessibilityLabel="Loading" />;
  }

  return (
    <View style={[styles.flex, { backgroundColor: theme.colors.background }]}>
      <ScrollView
        testID="connections-scroll"
        contentContainerStyle={[styles.content, { paddingTop: insets.top + 16 }]}
        refreshControl={
          <RefreshControl
            refreshing={connectors.isRefetching}
            onRefresh={() => void connectors.refetch()}
            colors={[theme.colors.primary]}
            tintColor={theme.colors.primary}
            progressBackgroundColor={theme.colors.elevation.level3}
          />
        }
      >
        <Text variant="headlineSmall" style={styles.pad}>
          Connections
        </Text>
        {body}
      </ScrollView>
      <FAB
        icon="plus"
        label="Add bank"
        onPress={() => router.push('/connections/add')}
        style={[styles.fab, { right: 16 + insets.right, bottom: 16 }]}
        testID="add-bank"
      />
      <Portal>
        {renaming ? (
          <RenameDialog
            key={renaming.id}
            connector={renaming}
            busy={dialogBusy}
            onCancel={() => setRenaming(null)}
            onSave={(name) => void rename(renaming, name)}
          />
        ) : null}
        {deleting ? (
          <DeleteDialog
            connector={deleting.connector}
            confirmPurge={deleting.confirm}
            busy={dialogBusy}
            onKeep={() => void remove(deleting.connector, 'keep')}
            onAskPurge={() => setDeleting({ ...deleting, confirm: true })}
            onPurge={() => void remove(deleting.connector, 'purge')}
            onCancel={() => setDeleting(null)}
          />
        ) : null}
      </Portal>
      <Snackbar visible={toast !== null} onDismiss={() => setToast(null)} duration={5000}>
        {toast ?? ''}
      </Snackbar>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { paddingBottom: 112 },
  pad: { paddingHorizontal: 16 },
  section: { marginTop: 16, marginBottom: 4 },
  avatar: { justifyContent: 'center', marginLeft: 16, marginRight: 4 },
  right: { flexDirection: 'row', alignItems: 'center', alignSelf: 'center' },
  status: { padding: 4 },
  message: { gap: 12, alignItems: 'flex-start' },
  fab: { position: 'absolute' },
  dialogContent: { gap: 12 },
  hint: { marginTop: 8 },
});

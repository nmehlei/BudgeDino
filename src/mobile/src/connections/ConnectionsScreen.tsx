import type { ConnectorInfo } from '@budgedino/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { ActivityIndicator, Button, Snackbar, Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useApi } from '../api/useApi';
import { formatDate, formatRelative } from '../format/time';
import { useAppTheme } from '../theme';
import { connectorTypeLabel } from './banks';
import { challengeStore } from './challenge-store';
import { connectorsKey, describeActionError, useConnectors } from './queries';

const STATUS_LABEL: Record<ConnectorInfo['status'], string> = {
  ok: 'Connected',
  needs_attention: 'Needs attention',
  error: 'Error',
  disabled: 'Disabled',
};

function consentText(iso: string | null, now: number): string | null {
  if (!iso) return null;
  return Date.parse(iso) <= now
    ? `Consent expired ${formatDate(iso)}`
    : `Consent valid until ${formatDate(iso)}`;
}

interface CardProps {
  connector: ConnectorInfo;
  busy: boolean;
  onSync: (id: string) => void;
  onReconnect: (id: string) => void;
}

function ConnectorCard({ connector: c, busy, onSync, onReconnect }: CardProps) {
  const theme = useAppTheme();
  const now = Date.now();
  const bad = c.status === 'needs_attention' || c.status === 'error';
  const consent = c.isOwner ? consentText(c.consentExpiresAt, now) : null;
  return (
    <View
      style={[styles.card, { backgroundColor: theme.colors.surfaceVariant }]}
      testID={`connector-${c.id}`}
    >
      <Text variant="titleMedium">{connectorTypeLabel(c.type)}</Text>
      <Text
        variant="labelLarge"
        style={{ color: bad ? theme.colors.error : theme.colors.onSurfaceVariant }}
        testID={`connector-status-${c.id}`}
      >
        {STATUS_LABEL[c.status]}
      </Text>
      <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
        {c.lastSuccessAt ? `Last sync ${formatRelative(c.lastSuccessAt, now)}` : 'Never synced'}
      </Text>
      {consent ? (
        <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
          {consent}
        </Text>
      ) : null}
      {c.isOwner ? (
        <View style={styles.actions}>
          {c.status === 'ok' ? (
            <Button
              mode="contained-tonal"
              disabled={busy}
              loading={busy}
              onPress={() => onSync(c.id)}
              testID={`sync-${c.id}`}
            >
              Sync now
            </Button>
          ) : null}
          {bad ? (
            <Button
              mode="contained"
              disabled={busy}
              loading={busy}
              onPress={() => onReconnect(c.id)}
              testID={`reconnect-${c.id}`}
            >
              Reconnect
            </Button>
          ) : null}
        </View>
      ) : (
        <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
          Shared by another member
        </Text>
      )}
    </View>
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

  const own = (connectors.data ?? []).filter((c) => c.isOwner);
  const others = (connectors.data ?? []).filter((c) => !c.isOwner);

  let body;
  if (connectors.data) {
    body = (
      <>
        {own.length === 0 ? (
          <Text variant="bodyMedium">No bank connected yet.</Text>
        ) : (
          own.map((c) => (
            <ConnectorCard
              key={c.id}
              connector={c}
              busy={busyId === c.id}
              onSync={sync}
              onReconnect={reconnect}
            />
          ))
        )}
        {others.length > 0 ? (
          <>
            <Text variant="titleSmall" style={styles.section}>
              Shared by others
            </Text>
            {others.map((c) => (
              <ConnectorCard
                key={c.id}
                connector={c}
                busy={false}
                onSync={sync}
                onReconnect={reconnect}
              />
            ))}
          </>
        ) : null}
      </>
    );
  } else if (connectors.isError) {
    body = (
      <View style={styles.message} testID="connections-error">
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
        <Text variant="headlineSmall">Connections</Text>
        {body}
        <Button
          mode="outlined"
          icon="plus"
          onPress={() => router.push('/connections/add')}
          testID="add-bank"
        >
          Add bank
        </Button>
      </ScrollView>
      <Snackbar visible={toast !== null} onDismiss={() => setToast(null)} duration={5000}>
        {toast ?? ''}
      </Snackbar>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { paddingHorizontal: 16, gap: 12, paddingBottom: 48 },
  card: { padding: 16, gap: 6, borderRadius: 12 },
  actions: { gap: 8, marginTop: 8 },
  section: { marginTop: 8 },
  message: { gap: 12, alignItems: 'flex-start' },
});

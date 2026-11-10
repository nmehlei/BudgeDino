import type { SessionInfo } from '@budgedino/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { ActivityIndicator, Button, List, Snackbar, Text } from 'react-native-paper';

import { useApi } from '../api/useApi';
import { formatRelative } from '../format/time';
import { SettingsPage } from './SettingsPage';

export const sessionsKey = ['sessions'] as const;

function deviceLabel(session: SessionInfo): string {
  return session.deviceName ?? 'Unknown device';
}

function lastSeen(session: SessionInfo): string {
  return session.lastSeenAt ? `Last active ${formatRelative(session.lastSeenAt)}` : 'Never active';
}

/** Signed-in devices; other devices can be signed out (revoked) after confirmation. */
export function DevicesScreen() {
  const api = useApi();
  const client = useQueryClient();
  const [message, setMessageState] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const setMessage = (m: string | null) => {
    if (mounted.current) setMessageState(m);
  };

  const sessions = useQuery({
    queryKey: sessionsKey,
    queryFn: async () => (await api.listSessions()).sessions,
  });

  const revoke = (session: SessionInfo) => {
    Alert.alert('Sign out this device?', `${deviceLabel(session)} will need to sign in again.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign out device',
        style: 'destructive',
        onPress: () => {
          setBusyId(session.id);
          api.revokeSession(session.id).then(
            () => {
              if (mounted.current) setBusyId(null);
              void client.invalidateQueries({ queryKey: sessionsKey });
            },
            () => {
              if (mounted.current) setBusyId(null);
              setMessage("Couldn't sign out that device. Try again.");
            },
          );
        },
      },
    ]);
  };

  return (
    <SettingsPage
      title="Devices"
      overlay={
        <Snackbar visible={message !== null} onDismiss={() => setMessage(null)} duration={4000}>
          {message ?? ''}
        </Snackbar>
      }
    >
      {sessions.isPending ? (
        <ActivityIndicator animating accessibilityLabel="Loading devices" />
      ) : sessions.isError ? (
        <View style={styles.padded}>
          <Text variant="bodyMedium">Couldn&apos;t load your devices.</Text>
          <Button onPress={() => void sessions.refetch()} testID="settings-sessions-retry">
            Retry
          </Button>
        </View>
      ) : (
        sessions.data.map((session) => (
          <List.Item
            key={session.id}
            title={session.current ? `${deviceLabel(session)} (this device)` : deviceLabel(session)}
            titleNumberOfLines={0}
            description={lastSeen(session)}
            left={(p) => <List.Icon {...p} icon="cellphone" />}
            right={() =>
              session.current ? null : (
                <Button
                  onPress={() => revoke(session)}
                  disabled={busyId === session.id}
                  testID={`settings-revoke-${session.id}`}
                >
                  Sign out
                </Button>
              )
            }
            testID={`settings-session-${session.id}`}
          />
        ))
      )}
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  padded: { padding: 16, gap: 8 },
});

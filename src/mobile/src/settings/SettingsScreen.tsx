import type { SessionInfo } from '@budgedino/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Alert, ScrollView, StyleSheet, View } from 'react-native';
import {
  ActivityIndicator,
  Button,
  Divider,
  List,
  Snackbar,
  Switch,
  Text,
} from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useApi } from '../api/useApi';
import { formatRelative } from '../format/time';
import { useNotificationPermission } from '../notifications/useNotificationPermission';
import { authenticateDevice } from '../security/device-auth';
import { getSessionStore } from '../session/instance';
import { revokeCurrentSession } from '../session/revoke-current';
import { useSession } from '../session/useSession';
import { useAppTheme } from '../theme';

export const sessionsKey = ['sessions'] as const;

function deviceLabel(session: SessionInfo): string {
  return session.deviceName ?? 'Unknown device';
}

function lastSeen(session: SessionInfo): string {
  return session.lastSeenAt ? `Last active ${formatRelative(session.lastSeenAt)}` : 'Never active';
}

/**
 * Settings: accounts entry, notification permission, app lock toggle, signed-in devices (revoke
 * others), the server URL and sign-out. Sign-out revokes this device's session on the server
 * (best effort, ignoring network errors) and then wipes everything local through the session store.
 */
export function SettingsScreen() {
  const theme = useAppTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const api = useApi();
  const client = useQueryClient();
  const { serverUrl, lockEnabled, setLockEnabled } = useSession();
  const notifications = useNotificationPermission();
  const [message, setMessageState] = useState<string | null>(null);
  const mounted = useRef(true);
  const lockBusy = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // Sign-out unmounts this screen while requests are still settling.
  const setMessage = (m: string | null) => {
    if (mounted.current) setMessageState(m);
  };
  const [busyId, setBusyId] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  const sessions = useQuery({
    queryKey: sessionsKey,
    queryFn: async () => (await api.listSessions()).sessions,
  });

  const toggleLock = async (next: boolean) => {
    if (lockBusy.current) return;
    lockBusy.current = true;
    try {
      if (next) {
        setLockEnabled(true);
        return;
      }
      // Turning the lock off needs the lock to be passed once (skipped when the device has no screen lock).
      const result = await authenticateDevice('Turn off the app lock');
      if (result === 'failed') {
        setMessage('The app lock stays on.');
        return;
      }
      setLockEnabled(false);
    } finally {
      lockBusy.current = false;
    }
  };

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

  const signOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      const store = getSessionStore();
      await store.userSignOut({ revoke: () => revokeCurrentSession(store, sessions.data) });
    } catch {
      setMessage('Signed out, but some local data could not be cleared.');
    } finally {
      if (mounted.current) setSigningOut(false);
    }
  };

  const confirmSignOut = () => {
    Alert.alert('Sign out?', 'This removes your session and all cached data from this phone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: () => void signOut() },
    ]);
  };

  return (
    <View style={[styles.flex, { backgroundColor: theme.colors.background }]}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 16, paddingBottom: 48 }}>
        <Text variant="headlineSmall" style={styles.title}>
          Settings
        </Text>
        <List.Item
          title="Accounts"
          description="Privacy and budget settings of your accounts"
          descriptionNumberOfLines={0}
          left={(p) => <List.Icon {...p} icon="bank-outline" />}
          right={(p) => <List.Icon {...p} icon="chevron-right" />}
          onPress={() => router.push('/settings/accounts')}
          testID="settings-accounts"
        />

        <Divider />
        <List.Item
          title="App lock"
          description="Ask for fingerprint, face or screen lock when opening the app"
          descriptionNumberOfLines={0}
          left={(p) => <List.Icon {...p} icon="lock-outline" />}
          right={() => (
            <Switch
              value={lockEnabled}
              onValueChange={(v) => void toggleLock(v)}
              testID="settings-lock"
              accessibilityLabel="App lock"
            />
          )}
        />

        {notifications.status === 'undetermined' || notifications.status === 'denied' ? (
          <List.Item
            title="Notifications are off"
            description={
              notifications.status === 'denied'
                ? 'Allow them for BudgeDino in the phone settings'
                : 'Get told about budgets and bank connections that need you'
            }
            descriptionNumberOfLines={0}
            left={(p) => <List.Icon {...p} icon="bell-off-outline" />}
            right={() =>
              notifications.status === 'undetermined' ? (
                <Button onPress={() => void notifications.request()} testID="settings-notify">
                  Allow
                </Button>
              ) : null
            }
          />
        ) : null}

        <Divider />
        <List.Subheader>Signed-in devices</List.Subheader>
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
              title={
                session.current ? `${deviceLabel(session)} (this device)` : deviceLabel(session)
              }
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

        <Divider />
        <List.Item
          title="Server"
          description={serverUrl ?? 'Not set'}
          descriptionNumberOfLines={0}
          left={(p) => <List.Icon {...p} icon="server-outline" />}
          testID="settings-server"
        />

        <View style={styles.padded}>
          <Button
            mode="contained-tonal"
            icon="logout"
            onPress={confirmSignOut}
            loading={signingOut}
            disabled={signingOut}
            testID="settings-signout"
          >
            Sign out
          </Button>
        </View>
      </ScrollView>
      <Snackbar visible={message !== null} onDismiss={() => setMessage(null)} duration={4000}>
        {message ?? ''}
      </Snackbar>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  title: { paddingHorizontal: 16, paddingBottom: 8 },
  padded: { padding: 16, gap: 8 },
});

import { useQueryClient } from '@tanstack/react-query';
import type { SessionInfo } from '@budgedino/shared';
import { useRouter, type Href } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { Button, Divider, List, Snackbar } from 'react-native-paper';

import { getSessionStore } from '../session/instance';
import { revokeCurrentSession } from '../session/revoke-current';
import { sessionsKey } from './DevicesScreen';
import { SettingsPage } from './SettingsPage';

const ENTRIES: { title: string; description: string; icon: string; href: Href; testID: string }[] =
  [
    {
      title: 'Appearance',
      description: 'System, light or dark',
      icon: 'palette-outline',
      href: '/more/settings/appearance',
      testID: 'settings-appearance',
    },
    {
      title: 'Security',
      description: 'App lock and notifications',
      icon: 'shield-lock-outline',
      href: '/more/settings/security',
      testID: 'settings-security',
    },
    {
      title: 'Devices',
      description: 'Where you are signed in',
      icon: 'cellphone',
      href: '/more/settings/devices',
      testID: 'settings-devices',
    },
    {
      title: 'Accounts',
      description: 'Privacy and budget settings of your accounts',
      icon: 'bank-outline',
      href: '/more/settings/accounts',
      testID: 'settings-accounts',
    },
    {
      title: 'Server',
      description: 'The server this app talks to',
      icon: 'server-outline',
      href: '/more/settings/server',
      testID: 'settings-server-entry',
    },
  ];

/**
 * Settings index: one row per sub-screen, then sign-out. Sign-out revokes this device's session on
 * the server (best effort, ignoring network errors) and then wipes everything local through the
 * session store.
 */
export function SettingsScreen() {
  const router = useRouter();
  const client = useQueryClient();
  const [message, setMessageState] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const mounted = useRef(true);
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

  const signOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      const store = getSessionStore();
      const cached = client.getQueryData<SessionInfo[]>(sessionsKey);
      await store.userSignOut({ revoke: () => revokeCurrentSession(store, cached) });
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
    <SettingsPage
      title="Settings"
      overlay={
        <Snackbar visible={message !== null} onDismiss={() => setMessage(null)} duration={4000}>
          {message ?? ''}
        </Snackbar>
      }
    >
      {ENTRIES.map((e, i) => (
        <View key={e.title}>
          {i > 0 ? <Divider /> : null}
          <List.Item
            title={e.title}
            description={e.description}
            descriptionNumberOfLines={0}
            left={(p) => <List.Icon {...p} icon={e.icon} />}
            right={(p) => <List.Icon {...p} icon="chevron-right" />}
            onPress={() => router.push(e.href)}
            testID={e.testID}
          />
        </View>
      ))}
      <Divider />
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
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  padded: { padding: 16, gap: 8 },
});

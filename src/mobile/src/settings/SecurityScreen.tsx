import { useEffect, useRef, useState } from 'react';
import { Button, List, Snackbar, Switch } from 'react-native-paper';

import { useNotificationPermission } from '../notifications/useNotificationPermission';
import { authenticateDevice } from '../security/device-auth';
import { useSession } from '../session/useSession';
import { SettingsPage } from './SettingsPage';

/** App lock toggle (turning it off needs the lock to be passed once) and the notification permission. */
export function SecurityScreen() {
  const { lockEnabled, setLockEnabled } = useSession();
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
  const setMessage = (m: string | null) => {
    if (mounted.current) setMessageState(m);
  };

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

  return (
    <SettingsPage
      title="Security"
      overlay={
        <Snackbar visible={message !== null} onDismiss={() => setMessage(null)} duration={4000}>
          {message ?? ''}
        </Snackbar>
      }
    >
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
    </SettingsPage>
  );
}

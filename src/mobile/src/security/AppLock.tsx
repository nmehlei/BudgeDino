import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AppState, StyleSheet, View } from 'react-native';
import { Button, Icon, Text } from 'react-native-paper';

import { getSessionStore } from '../session/instance';
import type { SessionStore } from '../session/session-store';
import { useSession } from '../session/useSession';
import { useAppTheme } from '../theme';
import { authenticateDevice, type DeviceAuthResult } from './device-auth';

/** Returning from the background after longer than this locks the app again. */
export const RELOCK_AFTER_MS = 60_000;

type Phase = 'locked' | 'notice' | 'unlocked';

interface AppLockProps {
  children: ReactNode;
  /** Test seams; the app uses the defaults. */
  store?: SessionStore;
  authenticate?: (promptMessage: string) => Promise<DeviceAuthResult>;
}

/**
 * Gates the authenticated tree behind biometric / device-credential authentication: on cold start
 * (unless the user just signed in with their password) and after the app spent more than 60 s in the
 * background. A failed or cancelled prompt leaves the app locked with an Unlock button. If the device
 * has no screen lock at all the prompt cannot work, so a one-time notice explains it and lets the user
 * in rather than locking them out. Children mount on the first unlock and stay mounted afterwards
 * (hidden while locked) so open screens keep their state.
 */
export function AppLock({
  children,
  store: injectedStore,
  authenticate = authenticateDevice,
}: AppLockProps) {
  const theme = useAppTheme();
  const [store] = useState(() => injectedStore ?? getSessionStore());
  const { lockEnabled } = useSession(store);

  const [phase, setPhase] = useState<Phase>(() =>
    store.getSnapshot().lockEnabled && store.getSignedInAt() === null ? 'locked' : 'unlocked',
  );
  const [shown, setShown] = useState(phase === 'unlocked');
  const authenticating = useRef(false);
  const backgroundedAt = useRef<number | null>(null);
  const mounted = useRef(true);

  const unlock = useCallback(() => {
    setShown(true);
    setPhase('unlocked');
  }, []);

  const attempt = useCallback(async () => {
    if (authenticating.current) return;
    authenticating.current = true;
    try {
      const result = await authenticate('Unlock BudgeDino');
      if (!mounted.current) return;
      if (result === 'success') unlock();
      else if (result === 'unavailable') {
        if (store.hasSeenLockNotice()) unlock();
        else setPhase('notice');
      }
      // 'failed' (cancelled, wrong finger, lockout): stay locked; the button retries.
    } finally {
      authenticating.current = false;
    }
  }, [authenticate, store, unlock]);

  useEffect(() => {
    mounted.current = true;
    if (phase === 'locked') void attempt();
    return () => {
      mounted.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the cold-start prompt runs once
  }, []);

  // Turning the lock off in Settings opens a locked app too.
  useEffect(() => {
    if (!lockEnabled) unlock();
  }, [lockEnabled, unlock]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'background') {
        // The system credential screen can background the app mid-prompt; that is not a relock cause.
        if (!authenticating.current) backgroundedAt.current ??= Date.now();
        return;
      }
      if (next !== 'active') return;
      const since = backgroundedAt.current;
      backgroundedAt.current = null;
      if (since === null || !store.getSnapshot().lockEnabled) return;
      if (Date.now() - since > RELOCK_AFTER_MS) {
        setPhase('locked');
        void attempt();
      }
    });
    return () => sub.remove();
  }, [attempt, store]);

  const continueFromNotice = () => {
    store.markLockNoticeSeen();
    unlock();
  };

  return (
    <View style={styles.flex}>
      {shown ? (
        <View
          style={[styles.flex, phase !== 'unlocked' && styles.hidden]}
          importantForAccessibility={phase === 'unlocked' ? 'auto' : 'no-hide-descendants'}
        >
          {children}
        </View>
      ) : null}
      {phase === 'locked' ? (
        <View
          style={[styles.cover, { backgroundColor: theme.colors.background }]}
          testID="app-lock"
        >
          <Icon source="lock-outline" size={64} color={theme.colors.primary} />
          <Text variant="titleLarge">BudgeDino is locked</Text>
          <Button mode="contained" onPress={() => void attempt()} testID="app-lock-unlock">
            Unlock
          </Button>
        </View>
      ) : null}
      {phase === 'notice' ? (
        <View
          style={[styles.cover, { backgroundColor: theme.colors.background }]}
          testID="app-lock-notice"
        >
          <Icon source="lock-alert-outline" size={64} color={theme.colors.primary} />
          <Text variant="titleLarge">No screen lock set up</Text>
          <Text variant="bodyMedium" style={styles.text}>
            The app lock needs a screen lock (PIN, pattern, password or fingerprint) on this device.
            Until you set one up in your phone&apos;s settings, BudgeDino opens without asking.
          </Text>
          <Button mode="contained" onPress={continueFromNotice} testID="app-lock-continue">
            Continue
          </Button>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  hidden: { display: 'none' },
  cover: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    padding: 24,
  },
  text: { textAlign: 'center' },
});

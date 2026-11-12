import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AppState, StyleSheet, View } from 'react-native';
import { Button, Icon, Text } from 'react-native-paper';

import { getSessionStore } from '../session/instance';
import type { SessionStore } from '../session/session-store';
import { revokeCurrentSession } from '../session/revoke-current';
import { useSession } from '../session/useSession';
import { useSplashFinished } from '../splash';
import { useAppTheme } from '../theme';
import { authenticateDevice, type DeviceAuthResult } from './device-auth';
import { isE2eLockBypass } from './e2e';

/** Returning from the background after longer than this locks the app again. */
export const RELOCK_AFTER_MS = 60_000;

/** `covered`: backgrounded while unlocked; opaque, no prompt (it may still be within the grace period). */
type Phase = 'locked' | 'notice' | 'unlocked' | 'covered';

interface AppLockProps {
  children: ReactNode;
  /** Test seams; the app uses the defaults. */
  store?: SessionStore;
  authenticate?: (promptMessage: string) => Promise<DeviceAuthResult>;
  revoke?: (store: SessionStore) => Promise<void>;
  /** Dev-only E2E build (development variant with BUDGEDINO_E2E=1): the lock never engages. */
  e2eBypass?: boolean;
  /** Test seam: whether the animated cold-start splash is over (default: the splash module's signal). */
  splashFinished?: boolean;
}

/**
 * Gates the authenticated tree behind biometric / device-credential authentication: on cold start
 * (unless the user just signed in with their password) and after the app spent more than 60 s in the
 * background. A failed or cancelled prompt leaves the app locked with an Unlock button. If the device
 * has no screen lock at all the prompt cannot work, so a one-time notice explains it and lets the user
 * in rather than locking them out. On cold start the lock screen shows at once (opaque, no content),
 * but the system prompt waits until the animated splash is over so it never covers the animation.
 * Children mount on the first unlock and stay mounted afterwards
 * (hidden while locked) so open screens keep their state.
 */
export function AppLock({
  children,
  store: injectedStore,
  authenticate = authenticateDevice,
  revoke = revokeCurrentSession,
  e2eBypass = isE2eLockBypass(),
  splashFinished: splashFinishedOverride,
}: AppLockProps) {
  const theme = useAppTheme();
  const splashFinishedSignal = useSplashFinished();
  const splashFinished = splashFinishedOverride ?? splashFinishedSignal;
  const [store] = useState(() => injectedStore ?? getSessionStore());
  const { lockEnabled } = useSession(store);

  const [phase, setPhase] = useState<Phase>(() =>
    !e2eBypass && store.getSnapshot().lockEnabled && store.getSignedInAt() === null
      ? 'locked'
      : 'unlocked',
  );
  const [shown, setShown] = useState(phase === 'unlocked');
  const authenticating = useRef(false);
  const backgroundedAt = useRef<number | null>(null);
  const mounted = useRef(true);
  /** The cold-start prompt has not run yet (it waits for the splash). */
  const coldStartPending = useRef(phase === 'locked');

  const unlock = useCallback(() => {
    setShown(true);
    setPhase('unlocked');
  }, []);

  const attempt = useCallback(async () => {
    if (authenticating.current) return;
    authenticating.current = true;
    coldStartPending.current = false;
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
    return () => {
      mounted.current = false;
    };
  }, []);

  // The cold-start prompt runs once, after the animated splash (the system prompt would cover it).
  useEffect(() => {
    if (!coldStartPending.current || !splashFinished) return;
    coldStartPending.current = false;
    if (phase === 'locked') void attempt();
  }, [splashFinished, phase, attempt]);

  // Turning the lock off in Settings opens a locked app too.
  useEffect(() => {
    if (!lockEnabled) unlock();
  }, [lockEnabled, unlock]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'background') {
        // The system credential screen can background the app mid-prompt; that is neither a cover nor a
        // relock cause. Otherwise cover at once: Android redraws the last frame on resume before React
        // could commit a lock state.
        if (authenticating.current || e2eBypass || !store.getSnapshot().lockEnabled) return;
        // Wall clock on purpose: elapsedRealtime is not available in JS, and a clock set back is treated
        // as expired (negative elapsed) below.
        backgroundedAt.current ??= Date.now();
        setPhase((p) => (p === 'unlocked' ? 'covered' : p));
        return;
      }
      if (next !== 'active') return;
      const since = backgroundedAt.current;
      backgroundedAt.current = null;
      if (since === null) return;
      const elapsed = Date.now() - since;
      if (
        e2eBypass ||
        !store.getSnapshot().lockEnabled ||
        (elapsed >= 0 && elapsed <= RELOCK_AFTER_MS)
      ) {
        setPhase((p) => (p === 'covered' ? 'unlocked' : p));
        return;
      }
      setPhase('locked');
      void attempt();
    });
    return () => sub.remove();
  }, [attempt, store, e2eBypass]);

  const signOut = () => {
    // The no-permanent-lockout escape: wipes the session and every cache.
    store.userSignOut({ revoke: () => revoke(store) }).catch(() => undefined);
  };

  const continueFromNotice = () => {
    store.markLockNoticeSeen();
    unlock();
  };

  return (
    <View style={styles.flex}>
      {shown ? (
        <View
          style={[styles.flex, (phase === 'locked' || phase === 'notice') && styles.hidden]}
          importantForAccessibility={phase === 'unlocked' ? 'auto' : 'no-hide-descendants'}
        >
          {children}
        </View>
      ) : null}
      {phase === 'covered' ? (
        <View
          style={[styles.cover, { backgroundColor: theme.colors.background }]}
          testID="app-lock-cover"
        />
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
          <Button mode="text" onPress={signOut} testID="app-lock-signout">
            Sign out
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

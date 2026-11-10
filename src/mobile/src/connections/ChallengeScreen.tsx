import type { ChallengeAnswerResponse, ChallengeStatus, ChallengeView } from '@budgedino/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppState,
  Image,
  KeyboardAvoidingView,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import { ActivityIndicator, Icon, Text, TextInput } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { isApiClientError } from '../api/errors';
import { useApi } from '../api/useApi';
import { useAppTheme } from '../theme';
import { challengeStore } from './challenge-store';
import { connectorsKey, describeActionError } from './queries';
import { WrappingButton } from './WrappingButton';

/** Never poll the bank faster than this, whatever `pollAfterMs` says. */
export const MIN_POLL_MS = 2000;

type Ended = { status: 'completed' | 'expired' | 'cancelled'; reason?: string };

const pollDelay = (view: ChallengeView): number =>
  Math.max(view.kind === 'decoupled' ? view.pollAfterMs : 0, MIN_POLL_MS);

function endedMessage(ended: Ended): string {
  if (ended.reason === 'declined') return 'The request was declined in your banking app.';
  if (ended.reason === 'too_many_invalid_answers') return 'Too many wrong codes were entered.';
  return ended.status === 'expired'
    ? 'The request expired before it was confirmed.'
    : 'The request was cancelled.';
}

/**
 * One bank challenge. The decoupled kind polls `POST /challenges/:id/answer` every `pollAfterMs`
 * (at least 2 s), waits out a 429 Retry-After, and stops while the app is in the background (the user
 * is confirming in the bank's app); on return it polls again as soon as the schedule allows. A client
 * timer on `expiresAt` turns a lapsed challenge into the expired state.
 */
export function ChallengeScreen({ id }: { id: string }) {
  const theme = useAppTheme();
  const router = useRouter();
  const api = useApi();
  const client = useQueryClient();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();

  const entry = challengeStore.get(id);
  const connectorId = useRef(entry?.connectorId ?? null);
  const [view, setView] = useState<ChallengeView | null>(entry?.view ?? null);
  const viewRef = useRef(view);
  const [ended, setEnded] = useState<Ended | null>(null);
  const [orphan, setOrphan] = useState(false);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [stopped, setStopped] = useState(false);
  const [tick, setTick] = useState(0);
  const [zoom, setZoom] = useState(false);
  const [appState, setAppState] = useState<string | null | undefined>(AppState.currentState);

  // Only an explicit background/inactive state pauses; an unknown initial state counts as foreground.
  const foreground = appState !== 'background' && appState !== 'inactive';

  const notBefore = useRef(Date.now() + (entry ? pollDelay(entry.view) : MIN_POLL_MS));
  const rateLimitedUntil = useRef(0);
  const inFlight = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const sub = AppState.addEventListener('change', setAppState);
    return () => sub.remove();
  }, []);

  const adopt = useCallback((next: ChallengeView) => {
    viewRef.current = next;
    setView(next);
    setCode('');
    setCodeError(null);
    notBefore.current = Date.now() + pollDelay(next);
    if (connectorId.current) challengeStore.set({ view: next, connectorId: connectorId.current });
  }, []);

  const finish = useCallback(
    (result: Ended) => {
      setEnded(result);
      challengeStore.delete(id);
      if (viewRef.current) challengeStore.delete(viewRef.current.id);
      if (result.status === 'completed') {
        void client.invalidateQueries({ queryKey: connectorsKey });
        void client.invalidateQueries({ queryKey: ['home'] });
        void client.invalidateQueries({ queryKey: ['accounts'] });
        void client.invalidateQueries({ queryKey: ['transactions'] });
      }
    },
    [client, id],
  );

  const applyStatus = useCallback(
    (status: ChallengeStatus, reason?: string) => {
      if (status === 'completed') finish({ status });
      else if (status !== 'open') finish({ status, ...(reason ? { reason } : {}) });
    },
    [finish],
  );

  const applyResponse = useCallback(
    (res: ChallengeAnswerResponse) => {
      if (res.status === 'open') {
        if (res.challenge) adopt(res.challenge);
        else if (viewRef.current) notBefore.current = Date.now() + pollDelay(viewRef.current);
      } else {
        applyStatus(res.status, res.reason);
      }
    },
    [adopt, applyStatus],
  );

  // A challenge we have no payload for (app restarted): the status tells whether it is still usable.
  useEffect(() => {
    if (entry) return;
    let cancelled = false;
    api.getChallenge(id).then(
      (res) => {
        if (cancelled) return;
        if (res.status === 'open') setOrphan(true);
        else applyStatus(res.status);
      },
      () => {
        if (!cancelled) setOrphan(true);
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per mount
  }, []);

  const pollOnce = useCallback(async () => {
    const current = viewRef.current;
    if (inFlight.current || !current || current.kind !== 'decoupled') return;
    inFlight.current = true;
    try {
      const res = await api.answerChallenge(current.id, { kind: 'decoupled' });
      if (!mounted.current) return;
      setNotice(null);
      setStopped(false);
      applyResponse(res);
    } catch (error) {
      if (!mounted.current) return;
      if (isApiClientError(error)) {
        const e = error.error;
        if (e.kind === 'unauthorized') return; // the session store signs the user out
        if (e.kind === 'rate_limited') {
          const waitMs = Math.max(e.retryAfterSec * 1000, MIN_POLL_MS);
          rateLimitedUntil.current = Date.now() + waitMs;
          notBefore.current = rateLimitedUntil.current;
          setNotice(`The bank asked us to wait. Checking again in ${Math.ceil(waitMs / 1000)} s.`);
          return;
        }
        if (e.kind === 'network') {
          notBefore.current = Date.now() + pollDelay(current);
          setNotice('No connection. Still waiting, will retry.');
          return;
        }
        if (e.kind === 'validation') {
          notBefore.current = Date.now() + pollDelay(current);
          return;
        }
      }
      setStopped(true);
      setNotice("Couldn't check the confirmation. Tap the button to try again.");
    } finally {
      inFlight.current = false;
      if (mounted.current) setTick((t) => t + 1);
    }
  }, [api, applyResponse]);

  // Auto-poll: one timer per run, re-armed by `tick`. Cleared while backgrounded or finished.
  useEffect(() => {
    if (!view || view.kind !== 'decoupled' || ended || stopped || !foreground) return;
    const timer = setTimeout(() => void pollOnce(), Math.max(notBefore.current - Date.now(), 0));
    return () => clearTimeout(timer);
  }, [view, ended, stopped, foreground, tick, pollOnce]);

  // Expiry: runs for every kind. On return from the background an overdue timer fires immediately.
  useEffect(() => {
    if (!view || ended || !foreground) return;
    const ms = Math.max(Date.parse(view.expiresAt) - Date.now(), 0);
    const timer = setTimeout(() => {
      const challengeId = view.id;
      api.getChallenge(challengeId).then(
        (res) => {
          if (!mounted.current || viewRef.current?.id !== challengeId) return;
          if (res.status === 'open') finish({ status: 'expired' });
          else applyStatus(res.status);
        },
        () => {
          if (mounted.current && viewRef.current?.id === challengeId) finish({ status: 'expired' });
        },
      );
    }, ms);
    return () => clearTimeout(timer);
  }, [view, ended, foreground, api, applyStatus, finish]);

  const confirmDecoupled = () => {
    const wait = rateLimitedUntil.current - Date.now();
    if (wait > 0) {
      setNotice(`The bank asked us to wait. Try again in ${Math.ceil(wait / 1000)} s.`);
      return;
    }
    setStopped(false);
    void pollOnce();
  };

  const submitCode = async () => {
    const current = viewRef.current;
    if (!current || (current.kind !== 'code' && current.kind !== 'image') || busy) return;
    const entered = code.trim();
    if (entered === '') return;
    setBusy(true);
    setCode('');
    setCodeError(null);
    try {
      const res = await api.answerChallenge(current.id, { kind: current.kind, code: entered });
      if (mounted.current) applyResponse(res);
    } catch (error) {
      if (!mounted.current) return;
      if (isApiClientError(error) && error.error.kind === 'validation') {
        setCodeError('Invalid input');
      } else {
        setCodeError(describeActionError(error, "Couldn't send the code. Try again."));
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const leave = () => {
    router.replace('/connections');
  };

  const cancel = async () => {
    const current = viewRef.current;
    if (current && !ended) {
      try {
        await api.cancelChallenge(current.id);
      } catch {
        // Best effort: the server expires the challenge on its own.
      }
    }
    challengeStore.delete(id);
    leave();
  };

  const retry = async () => {
    const connector = connectorId.current;
    if (!connector) {
      leave();
      return;
    }
    setBusy(true);
    try {
      const res = await api.reconnectConnector(connector);
      if (!mounted.current) return;
      if (res.challenge) {
        setEnded(null);
        setStopped(false);
        setNotice(null);
        adopt(res.challenge);
      } else {
        finish({ status: 'completed' });
      }
    } catch (error) {
      if (mounted.current) setNotice(describeActionError(error, "Couldn't reconnect."));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  let body;
  if (ended?.status === 'completed') {
    body = (
      <View style={styles.centered} testID="challenge-success">
        <Icon source="check-circle-outline" size={64} color={theme.colors.primary} />
        <Text variant="titleLarge">Bank connected</Text>
        <Text variant="bodyMedium">Your accounts will appear after the first sync.</Text>
        <WrappingButton mode="contained" onPress={leave} testID="challenge-done">
          Done
        </WrappingButton>
      </View>
    );
  } else if (ended) {
    body = (
      <View style={styles.centered} testID={`challenge-${ended.status}`}>
        <Icon source="alert-circle-outline" size={64} color={theme.colors.error} />
        <Text variant="titleLarge">
          {ended.status === 'expired' ? 'Request expired' : 'Request cancelled'}
        </Text>
        <Text variant="bodyMedium">{endedMessage(ended)}</Text>
        {notice ? <Text variant="bodyMedium">{notice}</Text> : null}
        <WrappingButton
          mode="contained"
          onPress={() => void retry()}
          loading={busy}
          disabled={busy}
        >
          Try again
        </WrappingButton>
        <WrappingButton mode="text" onPress={leave}>
          Back to connections
        </WrappingButton>
      </View>
    );
  } else if (!view) {
    body = orphan ? (
      <View style={styles.centered} testID="challenge-orphan">
        <Text variant="titleLarge">Request unavailable</Text>
        <Text variant="bodyMedium">
          This request can no longer be shown. Cancel it and start again from Connections.
        </Text>
        <WrappingButton mode="contained" onPress={() => void cancel()}>
          Cancel request
        </WrappingButton>
      </View>
    ) : (
      <ActivityIndicator animating accessibilityLabel="Loading" />
    );
  } else if (view.kind === 'decoupled') {
    body = (
      <View style={styles.centered} testID="challenge-decoupled">
        <Text variant="titleLarge">Confirm in your banking app</Text>
        <Text variant="bodyMedium">{view.message}</Text>
        <ActivityIndicator animating accessibilityLabel="Waiting for confirmation" />
        {notice ? (
          <Text variant="bodyMedium" testID="challenge-notice">
            {notice}
          </Text>
        ) : null}
        <WrappingButton mode="contained" onPress={confirmDecoupled} testID="challenge-confirm">
          I&apos;ve confirmed in my banking app
        </WrappingButton>
        <WrappingButton mode="text" onPress={() => void cancel()} testID="challenge-cancel">
          Cancel
        </WrappingButton>
      </View>
    );
  } else if (view.kind === 'code' || view.kind === 'image') {
    const imageUri =
      view.kind === 'image' ? `data:${view.mimeType};base64,${view.imageBase64}` : null;
    const length = view.kind === 'code' ? view.length : undefined;
    body = (
      <View style={styles.form} testID={`challenge-kind-${view.kind}`}>
        <Text variant="titleLarge">
          {view.kind === 'image' ? 'Scan the photoTAN' : 'Enter the TAN'}
        </Text>
        <Text variant="bodyMedium">{view.message}</Text>
        {imageUri ? (
          <Pressable
            onPress={() => setZoom(true)}
            accessibilityRole="imagebutton"
            accessibilityLabel="Enlarge the photoTAN image"
          >
            <Image
              source={{ uri: imageUri }}
              style={[styles.image, { width: width - 32 }]}
              resizeMode="contain"
              testID="challenge-image"
              accessibilityLabel="photoTAN image"
            />
          </Pressable>
        ) : null}
        <TextInput
          label="TAN"
          value={code}
          onChangeText={(v) => {
            setCode(v);
            setCodeError(null);
          }}
          keyboardType="number-pad"
          maxLength={length}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          importantForAutofill="no"
          textContentType="none"
          error={codeError !== null}
          onSubmitEditing={() => void submitCode()}
          testID="challenge-code"
        />
        {codeError ? (
          <Text variant="bodyMedium" style={{ color: theme.colors.error }} testID="challenge-error">
            {codeError}
          </Text>
        ) : null}
        <WrappingButton
          mode="contained"
          onPress={() => void submitCode()}
          disabled={busy || code.trim() === ''}
          loading={busy}
          testID="challenge-submit"
        >
          Submit
        </WrappingButton>
        <WrappingButton mode="text" onPress={() => void cancel()} testID="challenge-cancel">
          Cancel
        </WrappingButton>
        {imageUri ? (
          <Modal visible={zoom} onRequestClose={() => setZoom(false)} animationType="fade">
            <View style={[styles.zoom, { backgroundColor: theme.colors.background }]}>
              <ScrollView horizontal contentContainerStyle={styles.zoomScroll}>
                <ScrollView contentContainerStyle={styles.zoomScroll}>
                  <Image
                    source={{ uri: imageUri }}
                    style={{ width: width * 2.5, height: width * 2.5 }}
                    resizeMode="contain"
                    testID="challenge-image-zoomed"
                  />
                </ScrollView>
              </ScrollView>
              <View style={styles.zoomClose}>
                <WrappingButton onPress={() => setZoom(false)}>Close</WrappingButton>
              </View>
            </View>
          </Modal>
        ) : null}
      </View>
    );
  } else {
    body = (
      <View style={styles.centered} testID="challenge-unsupported">
        <Text variant="titleLarge">Not supported yet</Text>
        <Text variant="bodyMedium">
          This bank asks for a sign-in method the app can&apos;t handle yet.
        </Text>
        <WrappingButton mode="contained" onPress={() => void cancel()} testID="challenge-cancel">
          Cancel
        </WrappingButton>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={[styles.flex, { backgroundColor: theme.colors.background }]}
      behavior="padding"
    >
      <ScrollView
        contentContainerStyle={[styles.content, { paddingTop: insets.top + 24 }]}
        keyboardShouldPersistTaps="handled"
        testID="challenge-scroll"
      >
        {body}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { paddingHorizontal: 16, paddingBottom: 48, flexGrow: 1 },
  centered: { gap: 16, alignItems: 'stretch' },
  form: { gap: 12 },
  image: { aspectRatio: 1, alignSelf: 'center' },
  zoom: { flex: 1, paddingTop: 48 },
  zoomScroll: { flexGrow: 1 },
  zoomClose: { margin: 16 },
});

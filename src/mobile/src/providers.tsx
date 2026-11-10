import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { ThemeProvider } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, PaperProvider } from 'react-native-paper';
import { View } from 'react-native';

import { deleteMMKV } from 'react-native-mmkv';

import { isApiClientError } from './api/errors';
import { CACHE_STORE_ID, openSecureCache, type SecureCache } from './cache/secure-cache';
import { pendingRegistration } from './auth/pending-registration';
import { challengeStore } from './connections/challenge-store';
import { clearNotificationState } from './notifications/poll-task';
import { getSessionStore } from './session/instance';
import type { SessionStore } from './session/session-store';
import { toNavigationTheme } from './navigation-theme';
import { useAppTheme } from './theme';

interface AppProvidersProps {
  children: ReactNode;
  /** Test seams; the app uses the defaults. */
  queryClient?: QueryClient;
  sessionStore?: SessionStore;
  openCache?: () => Promise<SecureCache>;
}

/** Re-trying a 401 or 429 cannot help (the session is gone / the server asked us to back off). */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (isApiClientError(error)) {
    if (error.error.kind === 'unauthorized' || error.error.kind === 'rate_limited') return false;
  }
  return failureCount < 3;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: shouldRetryQuery } } });
}

/**
 * Wires theme, query client, the encrypted persisted cache and the session store. Children render
 * only after the cache key has been read from SecureStore, so no screen ever sees an unrestored
 * cache. If the cache cannot be opened the app still runs, just without persistence.
 */
export function AppProviders({
  children,
  queryClient: injectedClient,
  sessionStore,
  openCache = openSecureCache,
}: AppProvidersProps) {
  const theme = useAppTheme();
  const [queryClient] = useState(() => injectedClient ?? createQueryClient());
  const [store] = useState(() => sessionStore ?? getSessionStore());
  const [cache, setCache] = useState<SecureCache | 'unavailable' | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Hydrating first: a signed-out start (cache left behind by a 401 in the headless task, a failed
    // wipe, or the previous member) must not show or restore anyone's cached data. The wipe runs
    // before the persist provider mounts, so a restore cannot race it.
    const hydrated = store.hydrate();
    const wipeIfSignedOut = async (opened: SecureCache | 'unavailable') => {
      await hydrated;
      if (store.getSnapshot().status !== 'signed_out') return;
      queryClient.clear();
      void clearNotificationState();
      if (opened === 'unavailable') {
        try {
          deleteMMKV(CACHE_STORE_ID);
        } catch {
          // best effort
        }
      } else {
        opened.clear();
      }
    };
    openCache().then(
      async (opened) => {
        await wipeIfSignedOut(opened).catch(() => undefined);
        if (!cancelled) setCache(opened);
      },
      async () => {
        await wipeIfSignedOut('unavailable').catch(() => undefined);
        if (!cancelled) setCache('unavailable');
      },
    );
    // Sign-out always drops in-memory queries; the persisted store is cleared once it is open.
    const offQueries = store.onSignOut(() => {
      queryClient.clear();
    });
    // Always mounted, so it also runs for a sign-out from the lock screen before the first unlock.
    const offNotifications = store.onSignOut(() => clearNotificationState());
    // In-memory hand-over state must not outlive the session (pending TOTP secret, bank challenges).
    const offHandovers = store.onSignOut(() => {
      challengeStore.clear();
      pendingRegistration.clear();
    });
    return () => {
      cancelled = true;
      offQueries();
      offNotifications();
      offHandovers();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open once per mount
  }, []);

  useEffect(() => {
    if (cache === 'unavailable') {
      // No handle on the store, but a half-opened one may exist on disk: delete it on sign-out.
      return store.onSignOut(() => {
        try {
          deleteMMKV(CACHE_STORE_ID);
        } catch {
          // best effort
        }
      });
    }
    if (cache === null) return;
    return store.onSignOut(() => {
      cache.clear();
    });
  }, [cache, store]);

  let body: ReactNode;
  if (cache === null) {
    body = (
      <View
        style={{ flex: 1, justifyContent: 'center', backgroundColor: theme.colors.background }}
        accessibilityLabel="Loading"
      >
        <ActivityIndicator animating />
      </View>
    );
  } else if (cache === 'unavailable') {
    body = <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  } else {
    body = (
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{
          persister: cache.persister,
          maxAge: cache.maxAge,
          buster: cache.buster,
          dehydrateOptions: cache.dehydrateOptions,
        }}
      >
        {children}
      </PersistQueryClientProvider>
    );
  }

  return (
    <PaperProvider theme={theme}>
      <ThemeProvider value={toNavigationTheme(theme)}>{body}</ThemeProvider>
    </PaperProvider>
  );
}

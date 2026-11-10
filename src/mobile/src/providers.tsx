import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, PaperProvider } from 'react-native-paper';
import { View } from 'react-native';

import { openSecureCache, type SecureCache } from './cache/secure-cache';
import { getSessionStore } from './session/instance';
import type { SessionStore } from './session/session-store';
import { useAppTheme } from './theme';

interface AppProvidersProps {
  children: ReactNode;
  /** Test seams; the app uses the defaults. */
  queryClient?: QueryClient;
  sessionStore?: SessionStore;
  openCache?: () => Promise<SecureCache>;
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
  const [queryClient] = useState(() => injectedClient ?? new QueryClient());
  const [store] = useState(() => sessionStore ?? getSessionStore());
  const [cache, setCache] = useState<SecureCache | 'unavailable' | null>(null);

  useEffect(() => {
    let cancelled = false;
    openCache().then(
      (opened) => {
        if (!cancelled) setCache(opened);
      },
      () => {
        if (!cancelled) setCache('unavailable');
      },
    );
    // Sign-out always drops in-memory queries; the persisted store is cleared once it is open.
    const offQueries = store.onSignOut(() => {
      queryClient.clear();
    });
    void store.hydrate();
    return () => {
      cancelled = true;
      offQueries();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open once per mount
  }, []);

  useEffect(() => {
    if (cache === null || cache === 'unavailable') return;
    return store.onSignOut(() => {
      cache.clear();
    });
  }, [cache, store]);

  let body: ReactNode;
  if (cache === null) {
    body = (
      <View style={{ flex: 1, justifyContent: 'center' }} accessibilityLabel="Loading">
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

  return <PaperProvider theme={theme}>{body}</PaperProvider>;
}

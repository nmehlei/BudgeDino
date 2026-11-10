import { QueryClient } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { createApiClient } from '../api/client';
import { openSecureCache, type SecureCacheDeps } from '../cache/secure-cache';
import { ApiClientError } from '../api/errors';
import { pendingRegistration } from '../auth/pending-registration';
import { challengeStore } from '../connections/challenge-store';
import { clearNotificationState } from '../notifications/poll-task';
import { AppProviders, shouldRetryQuery } from '../providers';
import { createSessionStore } from '../session/session-store';

jest.mock('../notifications/poll-task', () => ({ clearNotificationState: jest.fn() }));
jest.mock('react-native-mmkv', () => ({ createMMKV: jest.fn(), deleteMMKV: jest.fn() }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
}));
jest.mock('expo-crypto', () => ({ getRandomBytes: jest.fn() }));

function fakeMmkv() {
  const data = new Map<string, string>();
  return {
    data,
    getString: (k: string) => data.get(k),
    set: (k: string, v: string) => {
      data.set(k, v);
    },
    remove: (k: string) => data.delete(k),
    clearAll: () => {
      data.clear();
    },
  };
}

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
});

function setup() {
  const cacheStore = fakeMmkv();
  let key: string | null = null;
  const deps: SecureCacheDeps = {
    readKey: async () => key,
    writeKey: async (k) => {
      key = k;
    },
    randomBytes: (n) => new Uint8Array(n).fill(5),
    openStore: () => cacheStore as never,
    deleteStore: jest.fn(),
    appVersion: '1.2.3',
  };
  let secret: string | null = 'tok';
  const store = createSessionStore({
    prefs: fakeMmkv(),
    token: {
      get: async () => secret,
      set: async (t) => {
        secret = t;
      },
      remove: async () => {
        secret = null;
      },
    },
  });
  const queryClient = new QueryClient();
  const openCache = jest.fn(() => openSecureCache(deps));
  return { cacheStore, store, queryClient, openCache, readSecret: () => secret };
}

async function renderReady(s: ReturnType<typeof setup>) {
  await render(
    <AppProviders queryClient={s.queryClient} sessionStore={s.store} openCache={s.openCache}>
      <Text>child</Text>
    </AppProviders>,
  );
  await act(async () => {
    await jest.advanceTimersByTimeAsync(10);
  });
}

describe('AppProviders', () => {
  it('shows a loading state until the cache is open, then renders children and hydrates', async () => {
    const s = setup();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const openCache = jest.fn(async () => {
      await gate;
      return s.openCache();
    });
    await render(
      <AppProviders queryClient={s.queryClient} sessionStore={s.store} openCache={openCache}>
        <Text>child</Text>
      </AppProviders>,
    );
    expect(screen.queryByText('child')).toBeNull();
    expect(screen.getByLabelText('Loading')).toBeTruthy();
    await act(async () => {
      release();
      await jest.advanceTimersByTimeAsync(10);
    });
    expect(screen.getByText('child')).toBeTruthy();
    expect(s.store.getSnapshot().status).toBe('signed_in');
  });

  it('a 401 through the client empties the QueryClient and the persisted store', async () => {
    const s = setup();
    await renderReady(s);

    s.queryClient.setQueryData(['accounts'], { accounts: [] });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1500); // the persister throttles writes
    });
    expect(s.cacheStore.data.size).toBe(1);
    expect(s.queryClient.getQueryCache().getAll()).toHaveLength(1);

    const client = createApiClient({
      baseUrl: 'https://x.test',
      getToken: s.store.getToken,
      onUnauthorized: () => s.store.signOut(),
      fetchImpl: (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch,
    });
    await act(async () => {
      await client.listAccounts().catch(() => undefined);
    });

    expect(s.readSecret()).toBeNull();
    expect(s.queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(s.cacheStore.data.size).toBe(0);
    // The emptied client may be re-persisted by the throttled subscriber; it must hold no queries.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1500);
    });
    for (const v of s.cacheStore.data.values()) {
      expect(
        (JSON.parse(v) as { clientState: { queries: unknown[] } }).clientState.queries,
      ).toEqual([]);
    }
  });

  it('a signed-out start wipes a leftover persisted cache and the query client', async () => {
    const s = setup();
    await s.store.signOut(); // no token: hydrate resolves to signed_out
    // Leave data behind as a headless 401 would.
    const seed = await s.openCache();
    await seed.persister.persistClient({
      timestamp: Date.now(),
      buster: seed.buster,
      clientState: { mutations: [], queries: [] },
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1500);
    });
    expect(s.cacheStore.data.size).toBe(1);
    s.queryClient.setQueryData(['accounts'], { x: 1 });
    await renderReady(s);
    expect(s.cacheStore.data.size).toBe(0);
    expect(s.queryClient.getQueryCache().getAll()).toHaveLength(0);
  });

  it('a signed-out start runs the notification cleanup', async () => {
    const s = setup();
    await s.store.signOut();
    jest.mocked(clearNotificationState).mockClear();
    await renderReady(s);
    expect(clearNotificationState).toHaveBeenCalled();
  });

  it('a sign-out with the app tree never unlocked still runs the notification cleanup', async () => {
    const s = setup();
    await renderReady(s);
    jest.mocked(clearNotificationState).mockClear();
    await act(async () => {
      await s.store.signOut();
    });
    expect(clearNotificationState).toHaveBeenCalledTimes(1);
  });

  it('sign-out clears the in-memory challenge and pending-registration hand-overs', async () => {
    const s = setup();
    await renderReady(s);
    challengeStore.set({
      view: { id: 'c1' } as never,
      connectorId: 'k1',
    });
    pendingRegistration.set({ pendingId: 'p', totpProvisioningUri: 'otpauth://x' });
    await act(async () => {
      await s.store.signOut();
    });
    expect(challengeStore.get('c1')).toBeUndefined();
    expect(pendingRegistration.get()).toBeNull();
  });

  it('a signed-out start with an unavailable cache deletes the MMKV store', async () => {
    const s = setup();
    await s.store.signOut();
    const { deleteMMKV } = jest.requireMock<{ deleteMMKV: jest.Mock }>('react-native-mmkv');
    await render(
      <AppProviders
        queryClient={s.queryClient}
        sessionStore={s.store}
        openCache={() => Promise.reject(new Error('no'))}
      >
        <Text>child</Text>
      </AppProviders>,
    );
    await act(async () => {
      await jest.advanceTimersByTimeAsync(10);
    });
    expect(deleteMMKV).toHaveBeenCalled();
  });

  it('never persists mutations (a paused login must not write the password)', async () => {
    const s = setup();
    await renderReady(s);
    const mutation = s.queryClient
      .getMutationCache()
      .build(s.queryClient, { mutationKey: ['login'], mutationFn: async () => 1 });
    mutation.state.variables = { password: 'hunter2-hunter2' };
    s.queryClient.setQueryData(['x'], 1); // triggers a persist
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1500);
    });
    const persisted = [...s.cacheStore.data.values()].join('');
    expect(persisted).not.toContain('hunter2');
    expect(
      (JSON.parse(persisted) as { clientState: { mutations: unknown[] } }).clientState.mutations,
    ).toEqual([]);
  });

  it('does not retry unauthorized or rate_limited errors, retries others up to 3 times (N5)', () => {
    expect(shouldRetryQuery(0, new ApiClientError({ kind: 'unauthorized' }))).toBe(false);
    expect(
      shouldRetryQuery(0, new ApiClientError({ kind: 'rate_limited', retryAfterSec: 5 })),
    ).toBe(false);
    expect(shouldRetryQuery(0, new ApiClientError({ kind: 'network' }))).toBe(true);
    expect(shouldRetryQuery(3, new ApiClientError({ kind: 'network' }))).toBe(false);
    expect(shouldRetryQuery(1, new Error('boom'))).toBe(true);
  });
});

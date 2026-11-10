import type { PersistedClient } from '@tanstack/react-query-persist-client';

import {
  CACHE_MAX_AGE_MS,
  encodeKey,
  openSecureCache,
  type SecureCacheDeps,
} from '../secure-cache';

jest.mock('react-native-mmkv', () => ({ createMMKV: jest.fn(), deleteMMKV: jest.fn() }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
}));
jest.mock('expo-crypto', () => ({ getRandomBytes: jest.fn() }));

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
});

/** The persister throttles writes (1 s); let the trailing write land. */
const flush = () => jest.advanceTimersByTimeAsync(1500);

function fakeStore() {
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

const client: PersistedClient = {
  timestamp: 1,
  buster: '',
  clientState: { mutations: [], queries: [] },
};

function makeDeps() {
  let key: string | null = null;
  const store = fakeStore();
  const openStore = jest.fn<ReturnType<SecureCacheDeps['openStore']>, [string]>(
    () => store as never,
  );
  const deps: SecureCacheDeps = {
    readKey: async () => key,
    writeKey: async (k) => {
      key = k;
    },
    randomBytes: (n) => Uint8Array.from({ length: n }, (_, i) => i * 11 + 3),
    openStore,
    deleteStore: jest.fn(),
  };
  return { deps, store, openStore, getKey: () => key };
}

describe('secure cache', () => {
  it('generates a 32-character key once and reuses it', async () => {
    const { deps, openStore, getKey } = makeDeps();
    await openSecureCache(deps);
    const first = getKey();
    expect(first).toHaveLength(32);
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
    await openSecureCache(deps);
    expect(getKey()).toBe(first);
    expect(openStore.mock.calls.map((c) => c[0])).toEqual([first, first]);
    expect(deps.deleteStore).toHaveBeenCalledTimes(1);
  });

  it('keeps persisted data readable across opens (offline start)', async () => {
    const { deps } = makeDeps();
    const first = await openSecureCache(deps);
    await first.persister.persistClient(client);
    await flush();
    const second = await openSecureCache(deps);
    expect(await second.persister.restoreClient()).toEqual(client);
  });

  it('clear() wipes the persisted client', async () => {
    const { deps, store } = makeDeps();
    const cache = await openSecureCache(deps);
    await cache.persister.persistClient(client);
    await flush();
    expect(store.data.size).toBe(1);
    cache.clear();
    expect(store.data.size).toBe(0);
    expect(await cache.persister.restoreClient()).toBeUndefined();
  });

  it('uses a 7 day max age', async () => {
    const { deps } = makeDeps();
    expect((await openSecureCache(deps)).maxAge).toBe(CACHE_MAX_AGE_MS);
    expect(CACHE_MAX_AGE_MS).toBe(7 * 24 * 3600 * 1000);
  });

  it('encodeKey is deterministic base64url without padding', () => {
    expect(encodeKey(Uint8Array.from([0xff, 0xff, 0xff]))).toBe('____');
    expect(encodeKey(new Uint8Array(24))).toBe('A'.repeat(32));
  });
});

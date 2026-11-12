import { QueryClient } from '@tanstack/react-query';
import type { PersistedClient } from '@tanstack/react-query-persist-client';

import {
  CACHE_MAX_AGE_MS,
  CACHE_SCHEMA_VERSION,
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
    appVersion: '1.2.3',
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
  it('deletes a keyless store before opening it (key missing, data present)', async () => {
    const { deps, openStore } = makeDeps();
    const order: string[] = [];
    (deps.deleteStore as jest.Mock).mockImplementation(() => order.push('delete'));
    openStore.mockImplementation(() => {
      order.push('open');
      return fakeStore() as never;
    });
    await openSecureCache(deps);
    expect(order).toEqual(['delete', 'open']);
  });

  it('treats a throwing readKey as a lost key: wipes the store and writes a new key', async () => {
    const { deps, getKey } = makeDeps();
    deps.readKey = async () => {
      throw new Error('KeyPermanentlyInvalidated');
    };
    await openSecureCache(deps);
    expect(deps.deleteStore).toHaveBeenCalledTimes(1);
    expect(getKey()).toHaveLength(32);
  });

  it('exposes a buster of schema and app version, and drops mutations from persistence', async () => {
    const { deps } = makeDeps();
    const cache = await openSecureCache(deps);
    expect(cache.buster).toBe(`${String(CACHE_SCHEMA_VERSION)}:1.2.3`);
    expect(cache.dehydrateOptions.shouldDehydrateMutation()).toBe(false);
  });

  it('persists transaction lists but never text-search results', async () => {
    const { deps } = makeDeps();
    const cache = await openSecureCache(deps);
    const client = new QueryClient();
    const keyed = (queryKey: readonly unknown[]) => {
      const query = client.getQueryCache().build(client, { queryKey });
      query.setData({});
      return query;
    };
    const { shouldDehydrateQuery } = cache.dehydrateOptions;
    expect(shouldDehydrateQuery(keyed(['transactions', 'list', {}]))).toBe(true);
    expect(shouldDehydrateQuery(keyed(['transactions', 'search', { q: 'rewe' }]))).toBe(false);
  });
});

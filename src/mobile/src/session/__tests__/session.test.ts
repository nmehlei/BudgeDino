import { createApiClient } from '../../api/client';
import { openSecureCache, type SecureCacheDeps } from '../../cache/secure-cache';
import { createSessionStore, type PrefsStorage, type TokenStorage } from '../session-store';

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
    set: (k: string, v: string | number | boolean | ArrayBuffer) => {
      data.set(k, String(v));
    },
    remove: (k: string) => data.delete(k),
    clearAll: () => {
      data.clear();
    },
  };
}

function setup() {
  const prefs = fakeMmkv();
  let secret: string | null = null;
  const token: TokenStorage = {
    get: async () => secret,
    set: async (t) => {
      secret = t;
    },
    remove: async () => {
      secret = null;
    },
  };
  const store = createSessionStore({ prefs: prefs as PrefsStorage, token });
  return { store, prefs, readSecret: () => secret };
}

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
});

describe('session store', () => {
  it('keeps server URL and device name in prefs, the token only in the token storage', async () => {
    const { store, prefs, readSecret } = setup();
    store.setServerUrl(' https://budget.example.test// ');
    store.setDeviceName('Pixel');
    await store.signIn('super-secret-token');
    expect(prefs.data.get('serverUrl')).toBe('https://budget.example.test');
    expect([...prefs.data.values()]).not.toContain('super-secret-token');
    expect(readSecret()).toBe('super-secret-token');
    expect(JSON.stringify(store.getSnapshot())).not.toContain('super-secret-token');
    expect(store.getSnapshot()).toEqual({
      status: 'signed_in',
      serverUrl: 'https://budget.example.test',
      deviceName: 'Pixel',
    });
  });

  it('hydrates status from the stored token and notifies subscribers', async () => {
    const { store } = setup();
    const listener = jest.fn();
    store.subscribe(listener);
    await store.hydrate();
    expect(store.getSnapshot().status).toBe('signed_out');
    await store.signIn('t');
    await store.hydrate();
    expect(store.getSnapshot().status).toBe('signed_in');
    expect(listener).toHaveBeenCalled();
  });

  it('signOut wipes the token and the query cache and the MMKV cache store', async () => {
    const { store, readSecret } = setup();

    // Real secure-cache wiring over fakes.
    const mmkv = fakeMmkv();
    let storedKey: string | null = null;
    const deps: SecureCacheDeps = {
      readKey: async () => storedKey,
      writeKey: async (k) => {
        storedKey = k;
      },
      randomBytes: (n) => new Uint8Array(n).fill(7),
      openStore: () => mmkv as never,
      deleteStore: jest.fn(),
      appVersion: '1.2.3',
    };
    const cache = await openSecureCache(deps);
    const clearQueryClient = jest.fn();
    store.onSignOut(clearQueryClient);
    store.onSignOut(() => {
      cache.clear();
    });

    await store.signIn('tok');
    await cache.persister.persistClient({
      timestamp: Date.now(),
      buster: '',
      clientState: { mutations: [], queries: [] },
    });
    await jest.advanceTimersByTimeAsync(1500); // the persister throttles writes
    expect(mmkv.data.size).toBe(1);

    await store.signOut();

    expect(readSecret()).toBeNull();
    expect(clearQueryClient).toHaveBeenCalledTimes(1);
    expect(mmkv.data.size).toBe(0);
    expect(store.getSnapshot().status).toBe('signed_out');
  });

  it('keeps server URL and device name across signOut', async () => {
    const { store } = setup();
    store.setServerUrl('https://x.test');
    store.setDeviceName('Pixel');
    await store.signIn('t');
    await store.signOut();
    expect(store.getSnapshot()).toEqual({
      status: 'signed_out',
      serverUrl: 'https://x.test',
      deviceName: 'Pixel',
    });
  });

  it('runs every wipe step even when one fails, then rethrows', async () => {
    const { store, readSecret } = setup();
    await store.signIn('t');
    const second = jest.fn();
    store.onSignOut(() => {
      throw new Error('boom');
    });
    store.onSignOut(second);
    await expect(store.signOut()).rejects.toThrow('boom');
    expect(second).toHaveBeenCalled();
    expect(readSecret()).toBeNull();
    expect(store.getSnapshot().status).toBe('signed_out');
  });

  it('a 401 from the api client signs the session out', async () => {
    const { store, readSecret } = setup();
    store.setServerUrl('https://x.test');
    await store.signIn('tok');
    const client = createApiClient({
      baseUrl: 'https://x.test',
      getToken: store.getToken,
      onUnauthorized: () => store.signOut(),
      fetchImpl: (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch,
    });
    await client.listAccounts().catch(() => undefined);
    expect(readSecret()).toBeNull();
    expect(store.getSnapshot().status).toBe('signed_out');
  });
  it('hydrate falls back to signed_out when the token read throws', async () => {
    const store = createSessionStore({
      prefs: fakeMmkv() as PrefsStorage,
      token: {
        get: async () => {
          throw new Error('keystore');
        },
        set: async () => undefined,
        remove: async () => undefined,
      },
    });
    await store.hydrate();
    expect(store.getSnapshot().status).toBe('signed_out');
  });

  it('signOut retries a failing token removal once', async () => {
    const remove = jest.fn().mockRejectedValueOnce(new Error('flaky')).mockResolvedValue(undefined);
    const store = createSessionStore({
      prefs: fakeMmkv() as PrefsStorage,
      token: { get: async () => 't', set: async () => undefined, remove },
    });
    await store.signOut();
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it('a token that survives a failed removal does not sign back in on the next hydrate', async () => {
    const prefs = fakeMmkv();
    let secret: string | null = 'leftover';
    let failRemove = true;
    const token: TokenStorage = {
      get: async () => secret,
      set: async (t) => {
        secret = t;
      },
      remove: async () => {
        if (failRemove) throw new Error('keystore busy');
        secret = null;
      },
    };
    const first = createSessionStore({ prefs: prefs as PrefsStorage, token });
    await expect(first.signOut()).rejects.toThrow('keystore busy');

    failRemove = false;
    const second = createSessionStore({ prefs: prefs as PrefsStorage, token });
    await second.hydrate();
    expect(second.getSnapshot().status).toBe('signed_out');
    expect(secret).toBeNull();
    // Marker cleared after the successful cleanup; a later sign-in works normally.
    await second.signIn('new');
    await createSessionStore({ prefs: prefs as PrefsStorage, token }).hydrate();
    expect(secret).toBe('new');
  });

  it('getToken returns null while the signed-out marker is set (N1)', async () => {
    const { store, prefs } = setup();
    await store.signIn('tok');
    expect(await store.getToken()).toBe('tok');
    prefs.data.set('signedOut', '1'); // e.g. a sign-out whose token removal failed
    expect(await store.getToken()).toBeNull();
  });

  it('still wipes token and hooks when the marker write fails (N2)', async () => {
    const { store, prefs, readSecret } = setup();
    await store.signIn('tok');
    const hook = jest.fn();
    store.onSignOut(hook);
    const realSet = prefs.set;
    prefs.set = (k, v) => {
      if (k === 'signedOut') throw new Error('mmkv write failed');
      realSet(k, v);
    };
    await expect(store.signOut()).rejects.toThrow('mmkv write failed');
    expect(readSecret()).toBeNull();
    expect(hook).toHaveBeenCalled();
    expect(store.getSnapshot().status).toBe('signed_out');
  });
});

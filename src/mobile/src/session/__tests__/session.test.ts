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
      expired: false,
      lockEnabled: true,
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

  it('persists the lock preference (default on) in prefs and reads it back', () => {
    const { store, prefs } = setup();
    expect(store.getSnapshot().lockEnabled).toBe(true);
    store.setLockEnabled(false);
    expect(store.getSnapshot().lockEnabled).toBe(false);
    expect(prefs.data.get('lockDisabled')).toBe('1');
    const again = createSessionStore({
      prefs: prefs as PrefsStorage,
      token: { get: async () => null, set: async () => undefined, remove: async () => undefined },
    });
    expect(again.getSnapshot().lockEnabled).toBe(false);
    store.setLockEnabled(true);
    expect(prefs.data.has('lockDisabled')).toBe(false);
  });

  it('knows about a sign-in in this process only (a restored session prompts the lock)', async () => {
    const { store } = setup();
    expect(store.getSignedInAt()).toBeNull();
    await store.signIn('t');
    expect(store.getSignedInAt()).not.toBeNull();
    await store.signOut();
    expect(store.getSignedInAt()).toBeNull();
  });

  it('a 401 during a user sign-out does not flag the session as expired', async () => {
    const { store } = setup();
    await store.signIn('t');
    let release: () => void = () => undefined;
    const off = store.onSignOut(() => new Promise<void>((r) => (release = r)));
    const out = store.signOut();
    await store.expireSession();
    expect(store.getSnapshot().expired).toBe(false);
    release();
    await out;
    off();
    await store.signIn('t');
    await store.expireSession();
    expect(store.getSnapshot().expired).toBe(true);
  });

  it('persists the expired notice across restarts until the login screen dismisses it', async () => {
    const prefs = fakeMmkv();
    const token: TokenStorage = {
      get: async () => 't',
      set: async () => undefined,
      remove: async () => undefined,
    };
    const a = createSessionStore({ prefs: prefs as PrefsStorage, token });
    await a.signIn('t');
    await a.expireSession();
    const b = createSessionStore({ prefs: prefs as PrefsStorage, token });
    expect(b.getSnapshot().expired).toBe(true);
    b.dismissExpiredNotice();
    expect(b.getSnapshot().expired).toBe(false);
    expect(createSessionStore({ prefs: prefs as PrefsStorage, token }).getSnapshot().expired).toBe(
      false,
    );
  });

  it('a user sign-out never persists the expired notice', async () => {
    const prefs = fakeMmkv();
    const token: TokenStorage = {
      get: async () => 't',
      set: async () => undefined,
      remove: async () => undefined,
    };
    const a = createSessionStore({ prefs: prefs as PrefsStorage, token });
    await a.signIn('t');
    await a.userSignOut();
    expect(createSessionStore({ prefs: prefs as PrefsStorage, token }).getSnapshot().expired).toBe(
      false,
    );
  });

  it('userSignOut raises the flag before the revoke: a 401 between revoke and wipe is not "expired"', async () => {
    const { store, readSecret } = setup();
    await store.signIn('t');
    await store.userSignOut({
      revoke: async () => {
        await store.expireSession(); // the 401 the revoke itself provokes
      },
    });
    expect(store.getSnapshot().expired).toBe(false);
    expect(store.getSnapshot().status).toBe('signed_out');
    expect(readSecret()).toBeNull();
  });

  it('userSignOut wipes locally even when the revoke fails; overlapping sign-outs keep the flag', async () => {
    const { store } = setup();
    await store.signIn('t');
    let release: () => void = () => undefined;
    const slow = store.userSignOut({ revoke: () => new Promise<void>((r) => (release = r)) });
    await store.userSignOut({ revoke: () => Promise.reject(new Error('net')) });
    await store.expireSession(); // first sign-out still running
    expect(store.getSnapshot().expired).toBe(false);
    release();
    await slow;
  });

  it('keeps the lock preference across signOut', async () => {
    const { store } = setup();
    store.setLockEnabled(false);
    await store.signIn('t');
    await store.signOut();
    expect(store.getSnapshot().lockEnabled).toBe(false);
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
      expired: false,
      lockEnabled: true,
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

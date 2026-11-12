import { createSessionApiClient } from '../../session/instance';
import { createSessionStore, type PrefsStorage } from '../../session/session-store';
import { createAuthApi } from '../api';

jest.mock('react-native-mmkv', () => ({ createMMKV: jest.fn(), deleteMMKV: jest.fn() }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
}));

function makeStore() {
  const data = new Map<string, string>([['serverUrl', 'https://h.test']]);
  const prefs: PrefsStorage = {
    getString: (k) => data.get(k),
    set: (k, v) => {
      data.set(k, v);
    },
    remove: (k) => {
      data.delete(k);
    },
  };
  let secret: string | null = 'tok';
  const store = createSessionStore({
    prefs,
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
  return { store, readSecret: () => secret };
}

const respond401 = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch;

describe('401 handling', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('a wrong login gives a typed unauthorized error and leaves the session alone', async () => {
    const { store, readSecret } = makeStore();
    await store.hydrate();
    const expire = jest.spyOn(store, 'expireSession');
    globalThis.fetch = jest.fn(respond401) as unknown as typeof fetch;

    await expect(
      createAuthApi('https://h.test').login({
        email: 'a@b.test',
        password: 'x',
        totpCode: '123456',
        deviceName: 'Pixel',
      }),
    ).rejects.toMatchObject({ error: { kind: 'unauthorized' } });

    expect(expire).not.toHaveBeenCalled();
    expect(store.getSnapshot().status).toBe('signed_in');
    expect(store.getSnapshot().expired).toBe(false);
    expect(readSecret()).toBe('tok');
  });

  it('a 401 through the session client reaches expireSession', async () => {
    const { store, readSecret } = makeStore();
    await store.hydrate();
    const expire = jest.spyOn(store, 'expireSession');

    await expect(createSessionApiClient(store, respond401).listAccounts()).rejects.toMatchObject({
      error: { kind: 'unauthorized' },
    });

    expect(expire).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toMatchObject({ status: 'signed_out', expired: true });
    expect(readSecret()).toBeNull();
  });
});

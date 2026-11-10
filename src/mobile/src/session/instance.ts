import {
  deleteItemAsync,
  getItemAsync,
  setItemAsync,
  WHEN_UNLOCKED_THIS_DEVICE_ONLY,
} from 'expo-secure-store';
import { createMMKV } from 'react-native-mmkv';

import { createApiClient } from '../api/client';
import { createSessionStore, type SessionStore } from './session-store';

export const SESSION_TOKEN_KEY = 'budgedino.session-token';

let instance: SessionStore | undefined;

/** The app-wide session store. Created lazily so importing this module touches no native code. */
export function getSessionStore(): SessionStore {
  instance ??= createSessionStore({
    prefs: createMMKV({ id: 'budgedino-prefs' }),
    token: {
      get: () => getItemAsync(SESSION_TOKEN_KEY),
      set: (token) =>
        setItemAsync(SESSION_TOKEN_KEY, token, {
          requireAuthentication: false,
          keychainAccessible: WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        }),
      remove: () => deleteItemAsync(SESSION_TOKEN_KEY),
    },
  });
  return instance;
}

/** API client bound to a session store: token from SecureStore, any 401 signs out. */
export function createSessionApiClient(store: SessionStore, fetchImpl?: typeof fetch) {
  const { serverUrl } = store.getSnapshot();
  if (!serverUrl) throw new Error('No server URL configured');
  return createApiClient({
    baseUrl: serverUrl,
    getToken: store.getToken,
    onUnauthorized: () => store.expireSession(),
    fetchImpl,
  });
}

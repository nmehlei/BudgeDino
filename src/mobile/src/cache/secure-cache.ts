import { defaultShouldDehydrateQuery, type Query } from '@tanstack/react-query';
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister';
import Constants from 'expo-constants';
import { getRandomBytes } from 'expo-crypto';
import { getItemAsync, setItemAsync, WHEN_UNLOCKED_THIS_DEVICE_ONLY } from 'expo-secure-store';
import { createMMKV, deleteMMKV, type MMKV } from 'react-native-mmkv';

import { isSearchQueryKey } from '../transactions/keys';

export const CACHE_STORE_ID = 'budgedino-cache';
export const CACHE_KEY_SECURE_STORE_KEY = 'budgedino.cache-key';
/** Persisted query data older than this is dropped on restore. */
export const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Bump when the shape of any persisted query data changes. */
export const CACHE_SCHEMA_VERSION = 1;

const KEY_BYTES = 24;
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * URL-safe base64 without padding. 24 random bytes give exactly 32 ASCII characters, which is
 * the 32-byte key MMKV needs for AES-256 (a 32-byte random key cannot be a valid string key).
 */
export function encodeKey(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64.charAt((n >> 18) & 63) + B64.charAt((n >> 12) & 63);
    out += B64.charAt((n >> 6) & 63) + B64.charAt(n & 63);
  }
  return out;
}

export interface SecureCacheDeps {
  readKey: () => Promise<string | null>;
  writeKey: (key: string) => Promise<void>;
  randomBytes: (n: number) => Uint8Array;
  openStore: (encryptionKey: string) => MMKV;
  /** Removes an orphaned store file (used only when a fresh key is generated). */
  deleteStore: () => void;
  appVersion: string;
}

export const defaultSecureCacheDeps: SecureCacheDeps = {
  readKey: () => getItemAsync(CACHE_KEY_SECURE_STORE_KEY, { requireAuthentication: false }),
  writeKey: (key) =>
    setItemAsync(CACHE_KEY_SECURE_STORE_KEY, key, {
      requireAuthentication: false,
      keychainAccessible: WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    }),
  randomBytes: getRandomBytes,
  openStore: (encryptionKey) =>
    createMMKV({
      id: CACHE_STORE_ID,
      encryptionKey,
      encryptionType: 'AES-256',
      // It is only a cache: an unreadable file is dropped, never an error surfaced to the user.
      recoveryStrategy: 'discard-on-error',
    }),
  appVersion: Constants.expoConfig?.version ?? '0',
  deleteStore: () => {
    deleteMMKV(CACHE_STORE_ID);
  },
};

/**
 * Opens the encrypted MMKV cache. The 256-bit key is generated once and kept in SecureStore, so
 * the cache is unreadable without the device keystore. Async because SecureStore reads are.
 */
export async function openSecureCache(deps: SecureCacheDeps = defaultSecureCacheDeps) {
  let key: string | null;
  try {
    key = await deps.readKey();
  } catch {
    // Keystore entry invalidated: treat the key as lost. A merely transient read failure takes
    // the same path and so deliberately wipes the cache (fail closed): it is only a cache.
    key = null;
  }
  if (!key) {
    key = encodeKey(deps.randomBytes(KEY_BYTES));
    // A store file without its key cannot be read again; start clean.
    deps.deleteStore();
    await deps.writeKey(key);
  }
  const storage = deps.openStore(key);

  const persister = createSyncStoragePersister({
    storage: {
      getItem: (k) => storage.getString(k) ?? null,
      setItem: (k, v) => {
        storage.set(k, v);
      },
      removeItem: (k) => {
        storage.remove(k);
      },
    },
    key: 'budgedino-query-cache',
  });

  return {
    persister,
    maxAge: CACHE_MAX_AGE_MS,
    /** Entries from another schema or app version are dropped on restore. */
    buster: `${String(CACHE_SCHEMA_VERSION)}:${deps.appVersion}`,
    /**
     * Only successful queries are persisted. Mutations never are: a paused login or register
     * mutation would otherwise write the password or TOTP code into MMKV.
     */
    dehydrateOptions: {
      shouldDehydrateMutation: () => false,
      // Search text and its results (payees, purposes) stay in memory only.
      shouldDehydrateQuery: (query: Query) =>
        defaultShouldDehydrateQuery(query) && !isSearchQueryKey(query.queryKey),
    },
    /** Wipes every persisted query. Used by sign-out. */
    clear: () => {
      persister.removeClient();
      storage.clearAll();
    },
  };
}

export type SecureCache = Awaited<ReturnType<typeof openSecureCache>>;

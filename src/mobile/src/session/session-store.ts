export type SessionStatus = 'loading' | 'signed_out' | 'signed_in';

/** Everything React may see. The token is deliberately not part of it. */
export interface SessionSnapshot {
  status: SessionStatus;
  serverUrl: string | null;
  deviceName: string | null;
  /** True after a 401 wiped the session; the login screen explains why. Cleared by the next sign-in. */
  expired: boolean;
}

/** Non-secret settings (MMKV `budgedino-prefs` in the app). */
export interface PrefsStorage {
  getString: (key: string) => string | undefined;
  set: (key: string, value: string) => void;
  remove: (key: string) => void;
}

/** The session token's only home (expo-secure-store in the app). */
export interface TokenStorage {
  get: () => Promise<string | null>;
  set: (token: string) => Promise<void>;
  remove: () => Promise<void>;
}

export interface SessionStoreDeps {
  prefs: PrefsStorage;
  token: TokenStorage;
}

const SERVER_URL_KEY = 'serverUrl';
const DEVICE_NAME_KEY = 'deviceName';
const SIGNED_OUT_KEY = 'signedOut';

/**
 * Canonical server URL: scheme and host lowercased (the path keeps its case), trailing slashes and a
 * pasted `/api/v1` suffix removed (the API client appends `/api/v1`).
 */
export function normalizeServerUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  const withoutApi = trimmed.replace(/\/api\/v1$/i, '').replace(/\/+$/, '');
  return withoutApi.replace(
    /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)/i,
    (_m, scheme: string, host: string) => scheme.toLowerCase() + host.toLowerCase(),
  );
}

export function createSessionStore({ prefs, token }: SessionStoreDeps) {
  let snapshot: SessionSnapshot = {
    status: 'loading',
    serverUrl: prefs.getString(SERVER_URL_KEY) ?? null,
    deviceName: prefs.getString(DEVICE_NAME_KEY) ?? null,
    expired: false,
  };
  const listeners = new Set<() => void>();
  const wipeHooks = new Set<() => void | Promise<void>>();

  function update(patch: Partial<SessionSnapshot>) {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((l) => {
      l();
    });
  }

  const store = {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,

    /** Reads the stored token once at app start to decide between login and the app. */
    async hydrate() {
      // A signed-out marker beats a leftover token (a failed removal must not sign back in).
      if (prefs.getString(SIGNED_OUT_KEY) === '1') {
        update({ status: 'signed_out' });
        try {
          await token.remove();
          prefs.remove(SIGNED_OUT_KEY);
        } catch {
          // keep the marker; the next hydrate retries
        }
        return;
      }
      try {
        const stored = await token.get();
        update({ status: stored ? 'signed_in' : 'signed_out' });
      } catch {
        update({ status: 'signed_out' });
      }
    },

    /** Reads the token fresh from SecureStore; it is never held in memory or React state. */
    getToken: async () => (prefs.getString(SIGNED_OUT_KEY) === '1' ? null : token.get()),

    setServerUrl(url: string) {
      const normalized = normalizeServerUrl(url);
      prefs.set(SERVER_URL_KEY, normalized);
      update({ serverUrl: normalized });
    },

    setDeviceName(name: string) {
      prefs.set(DEVICE_NAME_KEY, name);
      update({ deviceName: name });
    },

    async signIn(sessionToken: string) {
      await token.set(sessionToken);
      prefs.remove(SIGNED_OUT_KEY);
      update({ status: 'signed_in', expired: false });
    },

    /** Registers extra wipes for sign-out (the query client, the persisted cache). */
    onSignOut(hook: () => void | Promise<void>) {
      wipeHooks.add(hook);
      return () => {
        wipeHooks.delete(hook);
      };
    },

    /**
     * Wipes the token and every registered cache (query client, MMKV cache store). Server URL and
     * device name stay so the login screen is prefilled. Every step runs even if one fails; the
     * first failure is rethrown afterwards. The status flips to `signed_out` regardless.
     */
    async signOut() {
      const failures: unknown[] = [];
      // Marker first: if removal fails, the next hydrate still treats the session as signed out.
      try {
        prefs.set(SIGNED_OUT_KEY, '1');
      } catch (e) {
        failures.push(e); // a failing marker write must not skip the wipe steps below
      }
      try {
        try {
          await token.remove();
        } catch {
          await token.remove(); // one retry
        }
        prefs.remove(SIGNED_OUT_KEY);
      } catch (e) {
        failures.push(e);
      }
      for (const hook of wipeHooks) {
        try {
          await hook();
        } catch (e) {
          failures.push(e);
        }
      }
      update({ status: 'signed_out' });
      if (failures.length > 0) throw failures[0];
    },

    /** A 401 wiped the session: flags it so the login screen can say why, then signs out. */
    async expireSession(): Promise<void> {
      update({ expired: true });
      await store.signOut();
    },
  };
  return store;
}

export type SessionStore = ReturnType<typeof createSessionStore>;

export type SessionStatus = 'loading' | 'signed_out' | 'signed_in';

/** Everything React may see. The token is deliberately not part of it. */
export interface SessionSnapshot {
  status: SessionStatus;
  serverUrl: string | null;
  deviceName: string | null;
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

/** Removes trailing slashes; the API client appends `/api/v1`. */
export function normalizeServerUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export function createSessionStore({ prefs, token }: SessionStoreDeps) {
  let snapshot: SessionSnapshot = {
    status: 'loading',
    serverUrl: prefs.getString(SERVER_URL_KEY) ?? null,
    deviceName: prefs.getString(DEVICE_NAME_KEY) ?? null,
  };
  const listeners = new Set<() => void>();
  const wipeHooks = new Set<() => void | Promise<void>>();

  function update(patch: Partial<SessionSnapshot>) {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((l) => {
      l();
    });
  }

  return {
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
    getToken: () => token.get(),

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
      update({ status: 'signed_in' });
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
      prefs.set(SIGNED_OUT_KEY, '1');
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
  };
}

export type SessionStore = ReturnType<typeof createSessionStore>;

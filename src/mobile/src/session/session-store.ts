export type SessionStatus = 'loading' | 'signed_out' | 'signed_in';

/** Everything React may see. The token is deliberately not part of it. */
export interface SessionSnapshot {
  status: SessionStatus;
  serverUrl: string | null;
  deviceName: string | null;
  /** True after a 401 wiped the session; the login screen explains why. Cleared by the next sign-in. */
  expired: boolean;
  /** App lock preference (non-secret, MMKV). Default on. */
  lockEnabled: boolean;
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
const EXPIRED_NOTICE_KEY = 'expiredNotice';
const LOCK_DISABLED_KEY = 'lockDisabled';
const LOCK_NOTICE_SEEN_KEY = 'lockNoticeSeen';

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
    // Persisted: a 401 in the headless notification task has no UI to flag, so the next start shows it.
    expired: prefs.getString(EXPIRED_NOTICE_KEY) === '1',
    lockEnabled: prefs.getString(LOCK_DISABLED_KEY) !== '1',
  };
  /** Set when the user signed in during this process: they just authenticated, so no lock prompt. */
  let signedInAt: number | null = null;
  /** Counts sign-outs in progress (overlapping ones must not clear it early): in-flight 401s must not flag the session as expired. */
  let signingOut = 0;
  const listeners = new Set<() => void>();
  const wipeHooks = new Set<() => void | Promise<void>>();

  function update(patch: Partial<SessionSnapshot>) {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((l) => {
      l();
    });
  }

  async function runSignOut() {
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
    signedInAt = null;
    update({ status: 'signed_out' });
    if (failures.length > 0) throw failures[0];
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
      signedInAt = Date.now();
      prefs.remove(EXPIRED_NOTICE_KEY);
      update({ status: 'signed_in', expired: false });
    },

    /** The login screen has shown the "session expired" notice: forget it. */
    dismissExpiredNotice() {
      prefs.remove(EXPIRED_NOTICE_KEY);
      update({ expired: false });
    },

    /** Epoch ms of a sign-in in this process, or null when the session was restored from storage. */
    getSignedInAt: () => signedInAt,

    setLockEnabled(enabled: boolean) {
      if (enabled) prefs.remove(LOCK_DISABLED_KEY);
      else prefs.set(LOCK_DISABLED_KEY, '1');
      update({ lockEnabled: enabled });
    },

    /** The one-time "app lock needs a screen lock on this device" notice. */
    hasSeenLockNotice: () => prefs.getString(LOCK_NOTICE_SEEN_KEY) === '1',
    markLockNoticeSeen() {
      prefs.set(LOCK_NOTICE_SEEN_KEY, '1');
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
      signingOut++;
      try {
        await runSignOut();
      } finally {
        signingOut--;
      }
    },

    /**
     * User-initiated sign-out: raises the flag first (so 401s caused by the revoke itself never mark
     * the session expired), revokes the current session on the server (best effort), then wipes locally.
     */
    async userSignOut({ revoke }: { revoke?: () => Promise<void> } = {}) {
      signingOut++;
      try {
        try {
          await revoke?.();
        } catch {
          // network errors or a 401: the local wipe below is what matters
        }
        await runSignOut();
      } finally {
        signingOut--;
      }
    },

    /** A 401 wiped the session: flags it so the login screen can say why, then signs out. */
    async expireSession(): Promise<void> {
      // A user-initiated sign-out in progress: in-flight 401s are just its own revocation noise.
      if (signingOut > 0) return;
      // Already signed out (e.g. a late 401 from a request sent before a finished user sign-out): no stale notice.
      // 'loading' still counts as a session (the headless task may never hydrate), so only signed_out is skipped.
      if (snapshot.status === 'signed_out') return;
      try {
        prefs.set(EXPIRED_NOTICE_KEY, '1');
      } catch {
        // the in-memory flag below still covers this process
      }
      update({ expired: true });
      await store.signOut();
    },
  };
  return store;
}

export type SessionStore = ReturnType<typeof createSessionStore>;

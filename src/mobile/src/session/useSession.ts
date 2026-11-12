import { useSyncExternalStore } from 'react';

import { getSessionStore } from './instance';
import type { SessionSnapshot, SessionStore } from './session-store';

export interface UseSession extends SessionSnapshot {
  hydrate: SessionStore['hydrate'];
  setServerUrl: SessionStore['setServerUrl'];
  setDeviceName: SessionStore['setDeviceName'];
  setLockEnabled: SessionStore['setLockEnabled'];
  signIn: SessionStore['signIn'];
  signOut: SessionStore['signOut'];
  expireSession: SessionStore['expireSession'];
  dismissExpiredNotice: SessionStore['dismissExpiredNotice'];
}

/** React binding over the session store. Exposes status, server URL and device name, never the token. */
export function useSession(store: SessionStore = getSessionStore()): UseSession {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return {
    ...snapshot,
    hydrate: store.hydrate,
    setServerUrl: store.setServerUrl,
    setDeviceName: store.setDeviceName,
    setLockEnabled: store.setLockEnabled,
    signIn: store.signIn,
    signOut: store.signOut,
    expireSession: store.expireSession,
    dismissExpiredNotice: store.dismissExpiredNotice,
  };
}

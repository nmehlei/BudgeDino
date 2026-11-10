import { createSessionApiClient } from './instance';
import type { SessionStore } from './session-store';

/** Revokes the current session on the server (list, find `current`, DELETE). Throws on failure. */
export async function revokeCurrentSession(store: SessionStore): Promise<void> {
  const api = createSessionApiClient(store);
  const current = (await api.listSessions()).sessions.find((s) => s.current);
  if (current) await api.revokeSession(current.id);
}

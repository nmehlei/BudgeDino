import type { SessionInfo } from '@budgedino/shared';

import { createSessionApiClient } from './instance';
import type { SessionStore } from './session-store';

/**
 * Revokes the current session on the server (find `current`, DELETE). Pass an already loaded sessions
 * list to skip the extra list call. Throws on failure.
 */
export async function revokeCurrentSession(
  store: SessionStore,
  cachedSessions?: SessionInfo[],
): Promise<void> {
  const api = createSessionApiClient(store);
  const list = cachedSessions ?? (await api.listSessions()).sessions;
  const current = list.find((s) => s.current);
  if (current) await api.revokeSession(current.id);
}

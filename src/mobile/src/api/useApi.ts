import { useMemo } from 'react';

import { createSessionApiClient, getSessionStore } from '../session/instance';
import { useSession } from '../session/useSession';

export type SessionApi = ReturnType<typeof createSessionApiClient>;

/** Authenticated API client for the stored server; any 401 signs the user out. */
export function useApi(): SessionApi {
  const { serverUrl } = useSession();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- rebuilt only when the server changes
  return useMemo(() => createSessionApiClient(getSessionStore()), [serverUrl]);
}

import { useQuery } from '@tanstack/react-query';

import { useApi } from '../api/useApi';

export const membersKey = ['household', 'members'] as const;

export function useMembers() {
  const api = useApi();
  return useQuery({
    queryKey: membersKey,
    queryFn: async () => (await api.listMembers()).members,
  });
}

/**
 * Whether the caller is a household admin. `false` until known and whenever the lookup fails (including a
 * 403), so screens fall back to their read-only view instead of surfacing an error.
 */
export function useIsAdmin(): boolean {
  const { data } = useMembers();
  return data?.find((m) => m.isSelf)?.role === 'admin';
}

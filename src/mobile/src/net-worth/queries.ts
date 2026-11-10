import { useQuery } from '@tanstack/react-query';

import { isApiClientError } from '../api/errors';
import { useApi } from '../api/useApi';
import { shouldRetryQuery } from '../providers';

export const netWorthKey = ['net-worth'] as const;

export function useNetWorth() {
  const api = useApi();
  return useQuery({
    queryKey: netWorthKey,
    queryFn: () => api.getNetWorth(),
    // An unreachable server must surface within seconds, not after a long retry chain.
    retry: (count, error) =>
      isApiClientError(error) && error.error.kind === 'network'
        ? count < 1
        : shouldRetryQuery(count, error),
    networkMode: 'always',
  });
}

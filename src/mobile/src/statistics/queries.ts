import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { isNetworkError } from '../api/errors';
import { useApi } from '../api/useApi';
import { shouldRetryQuery } from '../providers';

/** `GET /statistics?months=`; each window is cached separately and the previous one stays while the next loads. */
export function useStatistics(months: 6 | 12) {
  const api = useApi();
  return useQuery({
    queryKey: ['statistics', months],
    queryFn: () => api.getStatistics(months),
    placeholderData: keepPreviousData,
    // An unreachable server must surface within seconds, not after a long retry chain (as on Home).
    retry: (count, error) => (isNetworkError(error) ? count < 1 : shouldRetryQuery(count, error)),
    networkMode: 'always',
  });
}

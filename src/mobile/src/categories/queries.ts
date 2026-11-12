import { useQuery } from '@tanstack/react-query';

import { isApiClientError } from '../api/errors';
import { useApi } from '../api/useApi';
import { describeBudgetError } from '../budgets/queries';
import { rulesKey } from './keys';

/** The caller's own categorization rules. */
export function useRules() {
  const api = useApi();
  return useQuery({
    queryKey: rulesKey,
    queryFn: async () => (await api.listRules()).rules,
  });
}

/** User-facing text for a failed category or rule action. Never includes request or response data. */
export function describeCategoryError(error: unknown, fallback: string): string {
  if (isApiClientError(error) && error.error.kind === 'server') {
    if (error.error.status === 403) return 'Only admins can change categories.';
    if (error.error.status === 404) return 'This item no longer exists.';
  }
  return describeBudgetError(error, '') || fallback;
}

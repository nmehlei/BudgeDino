import { useQuery } from '@tanstack/react-query';

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
  const text = describeBudgetError(error, '');
  if (text === 'Only admins can change budgets.') return 'Only admins can change categories.';
  if (text === 'This budget no longer exists.') return 'This item no longer exists.';
  return text || fallback;
}

import { useQuery } from '@tanstack/react-query';

import { isApiClientError } from '../api/errors';
import { useApi } from '../api/useApi';

export const budgetsKey = ['budgets'] as const;
export const categoriesKey = ['categories'] as const;

export function useBudgets() {
  const api = useApi();
  return useQuery({
    queryKey: budgetsKey,
    queryFn: async () => (await api.listBudgets()).budgets,
  });
}

/**
 * The household's categories. Archived ones are hidden unless `includeArchived` is set (they stay on old
 * transactions and budgets, but are never offered in a picker).
 */
export function useCategories({ includeArchived = false }: { includeArchived?: boolean } = {}) {
  const api = useApi();
  return useQuery({
    queryKey: categoriesKey,
    queryFn: async () => (await api.listCategories()).categories,
    select: (categories) => (includeArchived ? categories : categories.filter((c) => !c.archived)),
  });
}

/** User-facing text for a failed budget action. Never includes request or response data. */
export function describeBudgetError(error: unknown, fallback: string): string {
  if (isApiClientError(error)) {
    switch (error.error.kind) {
      case 'network':
        return 'No connection. Try again when you are online.';
      case 'rate_limited':
        return `Too many requests, try again in ${error.error.retryAfterSec} s.`;
      case 'unauthorized':
        return 'Your session expired.';
      case 'validation':
        return 'The server rejected these values. Check them and try again.';
      case 'server':
        if (error.error.status === 403) return 'Only admins can change budgets.';
        if (error.error.status === 404) return 'This budget no longer exists.';
        break;
      default:
        break;
    }
  }
  return fallback;
}

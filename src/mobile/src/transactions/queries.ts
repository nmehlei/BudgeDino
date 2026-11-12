import type {
  AccountInfo,
  CategoryInfo,
  ListTransactionsResponse,
  TransactionInfo,
  UpdateAccountRequest,
} from '@budgedino/shared';
import { useCallback, useSyncExternalStore } from 'react';
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';

import { isApiClientError } from '../api/errors';
import { useApi } from '../api/useApi';
import { txKeys } from './keys';

export const PAGE_SIZE = 50;

export { txKeys };

/** Server-side filters of the transaction list. All optional; `{}` is the plain list. */
export interface TransactionFilters {
  /** Already trimmed, at least 2 characters. Sensitive: never logged, never persisted. */
  q?: string;
  categoryId?: string;
  accountId?: string;
  uncategorized?: true;
  /** Inclusive `YYYY-MM-DD` booking dates. */
  from?: string;
  to?: string;
}

export const categoriesKey = ['categories'] as const;
export const accountsKey = ['accounts'] as const;

export type TransactionPages = InfiniteData<ListTransactionsResponse, string | undefined>;

export function useTransactionsList(filters: TransactionFilters = {}) {
  const api = useApi();
  const clean: TransactionFilters = {};
  if (filters.q) clean.q = filters.q;
  if (filters.categoryId) clean.categoryId = filters.categoryId;
  if (filters.accountId) clean.accountId = filters.accountId;
  if (filters.uncategorized) clean.uncategorized = true;
  if (filters.from) clean.from = filters.from;
  if (filters.to) clean.to = filters.to;
  return useInfiniteQuery<
    ListTransactionsResponse,
    Error,
    TransactionPages,
    readonly unknown[],
    string | undefined
  >({
    queryKey: [...(clean.q ? txKeys.search : txKeys.list), clean],
    queryFn: ({ pageParam }) =>
      api.listTransactions({ ...clean, cursor: pageParam, limit: PAGE_SIZE }),
    initialPageParam: undefined as string | undefined,
    // Keep showing the previous results while a new search or filter loads.
    placeholderData: keepPreviousData,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

/**
 * Finds a transaction in any cached list (plain, filtered or search) and follows cache updates, so a
 * search hit opens and an optimistic recategorize reaches it.
 */
export function useCachedTransaction(id: string): TransactionInfo | undefined {
  const client = useQueryClient();
  const find = useCallback(() => {
    for (const [, data] of client.getQueriesData<TransactionPages>({ queryKey: txKeys.all })) {
      for (const page of data?.pages ?? []) {
        const hit = page.transactions.find((t) => t.id === id);
        if (hit) return hit;
      }
    }
    return undefined;
  }, [client, id]);
  const subscribe = useCallback(
    (onChange: () => void) => client.getQueryCache().subscribe(onChange),
    [client],
  );
  return useSyncExternalStore(subscribe, find, find);
}

export function useCategories() {
  const api = useApi();
  return useQuery({
    queryKey: categoriesKey,
    queryFn: async () => (await api.listCategories()).categories,
  });
}

export function useAccounts() {
  const api = useApi();
  return useQuery({
    queryKey: accountsKey,
    queryFn: async () => (await api.listAccounts()).accounts,
  });
}

export function flattenPages(data: TransactionPages | undefined): TransactionInfo[] {
  const seen = new Set<string>();
  const out: TransactionInfo[] = [];
  for (const t of data?.pages.flatMap((p) => p.transactions) ?? []) {
    if (!seen.has(t.id)) {
      seen.add(t.id);
      out.push(t);
    }
  }
  return out;
}

/** Returns a copy of the pages with one transaction's category replaced (manual, as the server will). */
export function withCategory(
  data: TransactionPages,
  id: string,
  categoryId: string,
): TransactionPages {
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      transactions: page.transactions.map((t) =>
        t.id === id ? { ...t, categoryId, categorySource: 'manual' as const } : t,
      ),
    })),
  };
}

export type RecategorizeVars = {
  id: string;
  categoryId: string;
  applyToCounterparty: boolean;
};

interface Snapshot {
  key: readonly unknown[];
  data: TransactionPages | undefined;
}

/** Cancels in-flight list fetches, applies the new category in every cached list, returns the undo. */
export async function applyOptimisticCategory(
  client: QueryClient,
  vars: RecategorizeVars,
): Promise<Snapshot[]> {
  await client.cancelQueries({ queryKey: txKeys.all });
  const snapshots: Snapshot[] = client
    .getQueriesData<TransactionPages>({ queryKey: txKeys.all })
    .map(([key, data]) => ({ key, data }));
  for (const { key, data } of snapshots) {
    if (data)
      client.setQueryData<TransactionPages>(key, withCategory(data, vars.id, vars.categoryId));
  }
  return snapshots;
}

export function rollbackCategory(client: QueryClient, snapshots: readonly Snapshot[]): void {
  for (const { key, data } of snapshots) client.setQueryData(key, data);
}

/** User-facing text for a failed write. Never includes request or response data. */
export function describeWriteError(error: unknown): string {
  if (isApiClientError(error)) {
    switch (error.error.kind) {
      case 'network':
        return "No connection, the change wasn't saved.";
      case 'validation':
        return 'The server rejected this change, so it was undone.';
      case 'rate_limited':
        return `Too many requests, try again in ${error.error.retryAfterSec} s.`;
      case 'unauthorized':
        return 'Your session expired.';
      default:
        break;
    }
  }
  return "Couldn't save the change, it was undone.";
}

/**
 * Recategorizes one transaction. The list updates immediately and rolls back on any error; on
 * success home and the transaction queries are refetched (a counterparty rule can touch many rows
 * and moves budgets).
 */
export function useRecategorize() {
  const api = useApi();
  const client = useQueryClient();
  return useMutation({
    // Serial: a later optimistic update must not be overwritten by an earlier rollback.
    scope: { id: 'recategorize' },
    mutationFn: (vars: RecategorizeVars) =>
      api.patchTransaction(vars.id, {
        categoryId: vars.categoryId,
        ...(vars.applyToCounterparty ? { applyToCounterparty: true } : {}),
      }),
    onMutate: (vars) => applyOptimisticCategory(client, vars),
    onError: (_error, _vars, snapshots) => {
      if (snapshots) rollbackCategory(client, snapshots);
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['home'] });
    },
    // After any outcome the cache is refetched, so it ends up matching the server.
    onSettled: () => client.invalidateQueries({ queryKey: txKeys.all }),
  });
}

export function useUpdateAccount() {
  const api = useApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateAccountRequest }) =>
      api.updateAccount(id, patch),
    // Not optimistic: the server derives countsTowardBudgets from visibility, so show its answer.
    onSuccess: (updated: AccountInfo) => {
      client.setQueryData<AccountInfo[]>(accountsKey, (old) =>
        old?.map((a) => (a.id === updated.id ? updated : a)),
      );
      void client.invalidateQueries({ queryKey: ['home'] });
      void client.invalidateQueries({ queryKey: txKeys.all });
    },
  });
}

export function categoryNameMap(categories: readonly CategoryInfo[] | undefined) {
  return new Map((categories ?? []).map((c) => [c.id, c.name]));
}

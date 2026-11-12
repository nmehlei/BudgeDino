export const txKeys = {
  all: ['transactions'] as const,
  list: ['transactions', 'list'] as const,
  /** Text searches live under their own prefix so the offline cache can leave them out. */
  search: ['transactions', 'search'] as const,
};

/** Whether a query key belongs to a text search (whose results must not reach the offline cache). */
export function isSearchQueryKey(key: readonly unknown[]): boolean {
  return key[0] === txKeys.search[0] && key[1] === txKeys.search[1];
}

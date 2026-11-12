export const rulesKey = ['rules'] as const;

/** Whether a query key is the rules list, whose match values (IBANs, counterparty text) must not reach the offline cache. */
export function isRulesQueryKey(key: readonly unknown[]): boolean {
  return key[0] === rulesKey[0];
}

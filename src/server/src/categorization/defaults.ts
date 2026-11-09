export interface DefaultCategory {
  /** Stable slug; the schema has no `key` column yet, so bootstrap seeds by name. */
  key: string;
  name: string;
  isIncome?: boolean;
  isTransfer?: boolean;
}

/** Default German-household category set seeded for every new household (editable afterwards). */
export const DEFAULT_CATEGORIES: readonly DefaultCategory[] = [
  { key: 'groceries', name: 'Groceries' },
  { key: 'eating-out', name: 'Eating out' },
  { key: 'transport', name: 'Transport' },
  { key: 'housing', name: 'Housing' },
  { key: 'utilities', name: 'Utilities' },
  { key: 'insurance', name: 'Insurance' },
  { key: 'subscriptions', name: 'Subscriptions' },
  { key: 'shopping', name: 'Shopping' },
  { key: 'health', name: 'Health' },
  { key: 'kids', name: 'Kids' },
  { key: 'leisure', name: 'Leisure' },
  { key: 'travel', name: 'Travel' },
  { key: 'gifts-donations', name: 'Gifts & Donations' },
  { key: 'fees', name: 'Fees' },
  { key: 'cash', name: 'Cash' },
  { key: 'savings-investments', name: 'Savings & Investments' },
  { key: 'income', name: 'Income', isIncome: true },
  { key: 'transfer', name: 'Transfer', isTransfer: true },
  { key: 'uncategorized', name: 'Uncategorized' },
];

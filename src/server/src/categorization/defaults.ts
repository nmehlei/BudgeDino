import type { CategoryColorKey, CategoryIcon } from '@budgedino/shared';

export interface DefaultCategory {
  /** Stable slug, stored in `categories.key` (internal; never exposed by the API). */
  key: string;
  icon: CategoryIcon;
  color: CategoryColorKey;
  name: string;
  isIncome?: boolean;
  isTransfer?: boolean;
}

/** Default German-household category set seeded for every new household (editable afterwards). */
export const DEFAULT_CATEGORIES: readonly DefaultCategory[] = [
  { key: 'groceries', icon: 'cart', color: 'green', name: 'Groceries' },
  { key: 'eating-out', icon: 'silverware-fork-knife', color: 'orange', name: 'Eating out' },
  { key: 'transport', icon: 'bus', color: 'blue', name: 'Transport' },
  { key: 'housing', icon: 'home-variant', color: 'brown', name: 'Housing' },
  { key: 'utilities', icon: 'lightning-bolt', color: 'amber', name: 'Utilities' },
  { key: 'insurance', icon: 'shield-check', color: 'indigo', name: 'Insurance' },
  { key: 'subscriptions', icon: 'play-box-multiple', color: 'violet', name: 'Subscriptions' },
  { key: 'shopping', icon: 'shopping', color: 'pink', name: 'Shopping' },
  { key: 'health', icon: 'heart-pulse', color: 'rose', name: 'Health' },
  { key: 'kids', icon: 'teddy-bear', color: 'apricot', name: 'Kids' },
  { key: 'leisure', icon: 'ticket', color: 'teal', name: 'Leisure' },
  { key: 'travel', icon: 'airplane', color: 'sky', name: 'Travel' },
  { key: 'gifts-donations', icon: 'gift', color: 'red', name: 'Gifts & Donations' },
  { key: 'fees', icon: 'receipt-text', color: 'slate', name: 'Fees' },
  { key: 'cash', icon: 'cash', color: 'olive', name: 'Cash' },
  { key: 'savings-investments', icon: 'piggy-bank', color: 'gold', name: 'Savings & Investments' },
  { key: 'income', icon: 'cash-plus', color: 'accent', name: 'Income', isIncome: true },
  { key: 'transfer', icon: 'swap-horizontal', color: 'grey', name: 'Transfer', isTransfer: true },
  { key: 'uncategorized', icon: 'help', color: 'grey', name: 'Uncategorized' },
];

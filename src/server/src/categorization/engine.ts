import { DEFAULT_CATEGORIES } from './defaults.js';

export type CategorySource = 'rule' | 'learned' | 'heuristic' | 'manual' | 'none';

/** Case-insensitive; every present field must match. A match without any field never matches. */
export interface RuleMatch {
  counterpartyContains?: string;
  counterpartyIban?: string;
  purposeContains?: string;
  /** Bounds on the absolute amount in minor units (decimal strings, inclusive). */
  amountMinMinor?: string;
  amountMaxMinor?: string;
  accountId?: string;
}

export interface Rule {
  id: string;
  /** Higher wins. */
  priority: number;
  createdAt: Date;
  match: RuleMatch;
  categoryId: string;
  /** Member who created the rule (R18 scoping); null/absent when unknown. */
  createdBy?: string | null;
}

export interface DecryptedTx {
  accountId: string;
  amountMinor: bigint;
  currency: string;
  counterparty: string | null;
  counterpartyIban: string | null;
  counterpartyBidx: string | null;
  purpose: string | null;
  mcc: string | null;
  /** Current state; a `manual` source is never overwritten. */
  categoryId?: string | null;
  categorySource?: CategorySource;
}

export interface KeywordEntry {
  keyword: string;
  categoryId: string;
}

/** Heuristics resolved to category ids of one household. */
export interface Heuristics {
  mcc: ReadonlyMap<string, string>;
  keywords: readonly KeywordEntry[];
  incomeCategoryId: string | null;
}

export interface CategorizeContext {
  rules: readonly Rule[];
  /** counterparty_bidx -> category id of the most recent manual categorization. */
  learned: ReadonlyMap<string, string>;
  heuristics: Heuristics;
}

export interface CategorizeResult {
  categoryId: string | null;
  source: CategorySource;
}

/** MCC -> default category key (see `DEFAULT_CATEGORIES`). */
export const MCC_TABLE: Readonly<Record<string, string>> = {
  '5411': 'groceries',
  '5422': 'groceries',
  '5441': 'groceries',
  '5451': 'groceries',
  '5462': 'groceries',
  '5499': 'groceries',
  '5812': 'eating-out',
  '5813': 'eating-out',
  '5814': 'eating-out',
  '4111': 'transport',
  '4121': 'transport',
  '4131': 'transport',
  '5541': 'transport',
  '5542': 'transport',
  '7523': 'transport',
  '4900': 'utilities',
  '5912': 'health',
  '4814': 'subscriptions',
  '4899': 'subscriptions',
};

/** Merchant keyword -> default category key. Matched case-insensitively on word boundaries; first hit wins. */
export const KEYWORD_TABLE: readonly { keyword: string; category: string }[] = [
  ...['REWE', 'EDEKA', 'ALDI', 'LIDL', 'PENNY', 'NETTO', 'KAUFLAND', 'BIOCOMPANY', 'DENNS'].map(
    (keyword) => ({ keyword, category: 'groceries' }),
  ),
  ...['DB VERTRIEB', 'DEUTSCHE BAHN', 'BVG', 'MVG', 'HVV', 'FLIXBUS'].map((keyword) => ({
    keyword,
    category: 'transport',
  })),
  ...['NETFLIX', 'SPOTIFY', 'DISNEY'].map((keyword) => ({ keyword, category: 'subscriptions' })),
  // Drugstores sell mostly health/hygiene goods: Health (Shopping is the user's call via a rule).
  ...['DM-DROGERIE', 'ROSSMANN'].map((keyword) => ({ keyword, category: 'health' })),
  ...['LIEFERANDO', 'MCDONALD', 'STARBUCKS', 'BURGER KING'].map((keyword) => ({
    keyword,
    category: 'eating-out',
  })),
];

/** Purpose words that mark a positive amount as salary. */
export const SALARY_KEYWORDS = ['LOHN', 'GEHALT', 'SALARY'] as const;

const escapeRe = (s: string) => s.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
const boundaryRe = (keyword: string) =>
  new RegExp(
    `(?<![\\p{L}\\p{N}])${escapeRe(keyword.trim()).replaceAll(/\s+/g, String.raw`\s+`)}(?![\\p{L}\\p{N}])`,
    'iu',
  );

const reCache = new Map<string, RegExp>();
function wordMatch(text: string, keyword: string): boolean {
  let re = reCache.get(keyword);
  if (!re) {
    re = boundaryRe(keyword);
    reCache.set(keyword, re);
  }
  return re.test(text);
}

const normIban = (s: string) => s.replaceAll(/\s+/g, '').toUpperCase();
const contains = (haystack: string | null, needle: string) =>
  haystack !== null && haystack.toLowerCase().includes(needle.toLowerCase());
const abs = (n: bigint) => (n < 0n ? -n : n);

export function ruleMatches(match: RuleMatch, tx: DecryptedTx): boolean {
  if (Object.values(match).every((v) => v === undefined)) return false;
  if (
    match.counterpartyContains !== undefined &&
    !contains(tx.counterparty, match.counterpartyContains)
  ) {
    return false;
  }
  if (
    match.counterpartyIban !== undefined &&
    (tx.counterpartyIban === null ||
      normIban(tx.counterpartyIban) !== normIban(match.counterpartyIban))
  ) {
    return false;
  }
  if (match.purposeContains !== undefined && !contains(tx.purpose, match.purposeContains)) {
    return false;
  }
  if (match.accountId !== undefined && match.accountId !== tx.accountId) return false;
  const amount = abs(tx.amountMinor);
  if (match.amountMinMinor !== undefined && amount < BigInt(match.amountMinMinor)) return false;
  if (match.amountMaxMinor !== undefined && amount > BigInt(match.amountMaxMinor)) return false;
  return true;
}

/** Rules by priority (high first), then newest first, then id: a total order, so the result is deterministic. */
export function sortRules(rules: readonly Rule[]): Rule[] {
  return [...rules].sort(
    (a, b) =>
      b.priority - a.priority ||
      b.createdAt.getTime() - a.createdAt.getTime() ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

function heuristic(tx: DecryptedTx, h: Heuristics): string | null {
  // Salary first: employers may carry merchant names (Deutsche Bahn, REWE) and MCC codes.
  if (
    tx.amountMinor > 0n &&
    h.incomeCategoryId &&
    [tx.counterparty, tx.purpose].some(
      (f) => f !== null && SALARY_KEYWORDS.some((k) => wordMatch(f, k)),
    )
  ) {
    return h.incomeCategoryId;
  }
  if (tx.mcc !== null) {
    const byMcc = h.mcc.get(tx.mcc);
    if (byMcc) return byMcc;
  }
  for (const field of [tx.counterparty, tx.purpose]) {
    if (field === null) continue;
    for (const entry of h.keywords) {
      if (wordMatch(field, entry.keyword)) return entry.categoryId;
    }
  }
  return null;
}

/**
 * Precedence: manual (kept) -> rules -> learned -> heuristics (MCC, keywords, salary) -> none.
 * Pure and deterministic for a fixed context.
 */
export function categorize(tx: DecryptedTx, ctx: CategorizeContext): CategorizeResult {
  if (tx.categorySource === 'manual') {
    return { categoryId: tx.categoryId ?? null, source: 'manual' };
  }
  for (const rule of sortRules(ctx.rules)) {
    if (ruleMatches(rule.match, tx)) return { categoryId: rule.categoryId, source: 'rule' };
  }
  if (tx.counterpartyBidx !== null) {
    const learned = ctx.learned.get(tx.counterpartyBidx);
    if (learned) return { categoryId: learned, source: 'learned' };
  }
  const h = heuristic(tx, ctx.heuristics);
  if (h) return { categoryId: h, source: 'heuristic' };
  return { categoryId: null, source: 'none' };
}

/** Resolves the built-in tables against a household's categories (matched by name, so renamed ones drop out). */
export function buildHeuristics(
  categories: readonly { id: string; name: string; isIncome: boolean }[],
): Heuristics {
  const keyToName = new Map(DEFAULT_CATEGORIES.map((c) => [c.key, c.name]));
  const byName = new Map(categories.map((c) => [c.name, c.id]));
  const resolve = (key: string) => {
    const name = keyToName.get(key);
    return name === undefined ? undefined : byName.get(name);
  };
  const mcc = new Map<string, string>();
  for (const [code, key] of Object.entries(MCC_TABLE)) {
    const id = resolve(key);
    if (id) mcc.set(code, id);
  }
  const keywords: KeywordEntry[] = [];
  for (const { keyword, category } of KEYWORD_TABLE) {
    const id = resolve(category);
    if (id) keywords.push({ keyword, categoryId: id });
  }
  return {
    mcc,
    keywords,
    incomeCategoryId: categories.find((c) => c.isIncome)?.id ?? null,
  };
}

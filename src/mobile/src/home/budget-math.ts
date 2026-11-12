import type { BudgetView, HomeResponse } from '@budgedino/shared';

export type BarLevel = 'ok' | 'warn' | 'over';

export interface BarState {
  /** Bar fill, 0 to 100. */
  fillPercent: number;
  level: BarLevel;
  /** True when spending exceeds the budget (ratio above 1, or any spending on a zero budget). */
  overBudget: boolean;
  /** Whole percent actually used (not clamped at the top, clamped at 0). */
  usedPercent: number;
}

/** Parses the server's four-decimal ratio string ("1.2500") into basis points (12500) without floats. */
export function ratioToBps(ratio: string): number {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(ratio.trim());
  if (!m) return 0;
  const whole = Number(m[1]);
  const frac = (m[2] ?? '').padEnd(4, '0').slice(0, 4);
  return whole * 10000 + Number(frac);
}

function toBigInt(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

/**
 * Colour and fill for a budget bar. Fill is clamped to 0 to 100 %. Red from ratio 1, amber from 0.8.
 * A zero (or negative) budget has no meaningful ratio: no spending shows an empty bar, any positive
 * spending shows a full red bar.
 */
export function barState(budget: Pick<BudgetView, 'amount' | 'spent' | 'ratio'>): BarState {
  const amount = toBigInt(budget.amount.minor);
  const spent = toBigInt(budget.spent.minor);

  let bps: number;
  if (amount <= 0n) {
    bps = spent > 0n ? 10000 : 0;
  } else if (spent <= 0n) {
    bps = 0; // refunds can push spent below zero; the bar never goes backwards
  } else {
    bps = ratioToBps(budget.ratio);
  }

  const fillPercent = Math.min(100, bps / 100);
  const level: BarLevel = bps >= 10000 ? 'over' : bps >= 8000 ? 'warn' : 'ok';
  const overBudget = amount <= 0n ? spent > 0n : bps > 10000;
  return { fillPercent, level, overBudget, usedPercent: Math.floor(bps / 100) };
}

/**
 * How far spending exceeds the budget, in minor units of the budget's currency, or null when it does
 * not (or the two amounts are in different currencies, which the server never sends).
 */
export function overBy(
  budget: Pick<BudgetView, 'amount' | 'spent'>,
): { minor: string; currency: string } | null {
  if (budget.amount.currency !== budget.spent.currency) return null;
  const diff = toBigInt(budget.spent.minor) - toBigInt(budget.amount.minor);
  return diff > 0n ? { minor: diff.toString(), currency: budget.amount.currency } : null;
}

/**
 * Sums money amounts of one currency exactly (bigint minor units). Returns null when any amount is in
 * another currency, so a mixed total is never shown as if it were one.
 */
export function sumMoney(
  items: readonly { minor: string; currency: string }[],
  currency: string,
): { minor: string; currency: string } | null {
  let total = 0n;
  for (const item of items) {
    if (item.currency !== currency) return null;
    total += toBigInt(item.minor);
  }
  return { minor: total.toString(), currency };
}

/** Fraction of a period (`start` inclusive, `end` exclusive) elapsed at `now`, clamped to 0..1. */
export function elapsedFraction(period: { start: string; end: string }, now: Date): number {
  const start = Date.parse(period.start);
  const end = Date.parse(period.end);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return 0;
  return Math.min(1, Math.max(0, (now.getTime() - start) / (end - start)));
}

export type HomeGroup =
  | {
      kind: 'budget';
      budget: BudgetView;
      categories: Array<{
        categoryId: string;
        name: string;
        spent: HomeResponse['budgets'][number]['spent'] | null;
      }>;
    }
  | {
      kind: 'category';
      categoryId: string | null;
      name: string;
      spent: HomeResponse['breakdown'][number]['spent'];
    };

/**
 * The Home list: budget groups first (by budget name), each with its categories and their spending
 * (null when the category has none in the period), then the categories no budget covers, largest
 * spend first. A category in two budgets appears under both. `categoryNames` names covered categories
 * that have no spending (the breakdown only lists spent ones).
 */
export function groupForHome(
  budgets: readonly BudgetView[],
  breakdown: HomeResponse['breakdown'],
  categoryNames: ReadonlyMap<string, string> = new Map(),
): HomeGroup[] {
  const byId = new Map(
    breakdown.flatMap((b) => (b.categoryId === null ? [] : [[b.categoryId, b] as const])),
  );
  const covered = new Set(budgets.flatMap((b) => b.categoryIds));
  const budgetGroups: HomeGroup[] = [...budgets]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((budget) => ({
      kind: 'budget',
      budget,
      categories: budget.categoryIds.map((categoryId) => {
        const hit = byId.get(categoryId);
        return {
          categoryId,
          name: hit?.name ?? categoryNames.get(categoryId) ?? 'Category',
          spent: hit?.spent ?? null,
        };
      }),
    }));
  const rest: HomeGroup[] = breakdown
    .filter((b) => b.categoryId === null || !covered.has(b.categoryId))
    .map((b) => ({
      kind: 'category' as const,
      categoryId: b.categoryId,
      name: b.name,
      spent: b.spent,
    }))
    .sort((a, b) => {
      if (a.kind !== 'category' || b.kind !== 'category') return 0;
      const x = toBigInt(a.spent.minor);
      const y = toBigInt(b.spent.minor);
      return x === y ? 0 : x < y ? 1 : -1;
    });
  return [...budgetGroups, ...rest];
}

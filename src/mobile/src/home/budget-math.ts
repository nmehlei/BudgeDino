import type { BudgetView } from '@budgedino/shared';

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

/**
 * Share of each amount in the total of all positive amounts, as a 0 to 100 bar width (two decimals,
 * computed in bigint basis points). Zero and negative amounts (net refunds) get an empty bar.
 */
export function shareWidths(items: readonly { minor: string }[]): number[] {
  const values = items.map((i) => toBigInt(i.minor));
  const total = values.reduce((sum, v) => (v > 0n ? sum + v : sum), 0n);
  return values.map((v) => (total > 0n && v > 0n ? Number((v * 10000n) / total) / 100 : 0));
}

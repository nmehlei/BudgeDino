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

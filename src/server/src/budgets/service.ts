import { and, asc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import {
  money,
  periodFor,
  previousPeriod,
  toJSON,
  type BudgetView,
  type Money,
  type Period,
  type PeriodKind,
} from '@budgedino/shared';
import type { VisibleAccountIds } from '../access/visibility.js';
import { decryptString, encryptField, type DataKey } from '../crypto/index.js';
import type { Db } from '../db/client.js';
import { newId } from '../db/ids.js';
import {
  accounts,
  budgets,
  categories,
  households,
  transactionSplits,
  transactions,
} from '../db/schema.js';
import { createFxConverter, FxRateMissingError, type FxConverter } from '../fx/service.js';
import { toTransaction, type Split } from '../repositories/transactions.js';

const amountAad = (rowId: string) => ({ table: 'budgets', column: 'amount_minor', rowId });
const splitAad = (rowId: string) => ({ table: 'transaction_splits', column: 'amount', rowId });

export interface Budget {
  id: string;
  householdId: string;
  name: string;
  categoryIds: string[];
  periodKind: PeriodKind;
  amount: Money;
}

export interface HouseholdSettings {
  timezone: string;
  baseCurrency: string;
}

export async function householdSettings(db: Db, householdId: string): Promise<HouseholdSettings> {
  const [row] = await db
    .select({ timezone: households.timezone, baseCurrency: households.baseCurrency })
    .from(households)
    .where(eq(households.id, householdId));
  if (!row) throw new Error('Household not found');
  return row;
}

function toBudget(dk: DataKey, row: typeof budgets.$inferSelect): Budget {
  return {
    id: row.id,
    householdId: row.householdId,
    name: row.name,
    categoryIds: row.categoryIds,
    periodKind: row.periodKind,
    amount: money(BigInt(decryptString(dk, row.amountMinorEnc, amountAad(row.id))), row.currency),
  };
}

/** Active (non-archived) budgets of the household, oldest first. */
export async function listBudgets(db: Db, dk: DataKey, householdId: string): Promise<Budget[]> {
  const rows = await db
    .select()
    .from(budgets)
    .where(and(eq(budgets.householdId, householdId), eq(budgets.archived, false)))
    .orderBy(asc(budgets.name), asc(budgets.id));
  return rows.map((r) => toBudget(dk, r));
}

export async function getBudget(
  db: Db,
  dk: DataKey,
  householdId: string,
  id: string,
): Promise<Budget | null> {
  const [row] = await db
    .select()
    .from(budgets)
    .where(
      and(eq(budgets.id, id), eq(budgets.householdId, householdId), eq(budgets.archived, false)),
    );
  return row ? toBudget(dk, row) : null;
}

export interface BudgetInput {
  name: string;
  categoryIds: string[];
  periodKind: PeriodKind;
  amount: Money;
}

export async function insertBudget(
  db: Db,
  dk: DataKey,
  householdId: string,
  input: BudgetInput,
): Promise<Budget> {
  const id = newId();
  await db.insert(budgets).values({
    id,
    householdId,
    name: input.name,
    categoryIds: [...new Set(input.categoryIds)],
    periodKind: input.periodKind,
    amountMinorEnc: encryptField(dk, input.amount.minor.toString(), amountAad(id)),
    currency: input.amount.currency,
  });
  const created = await getBudget(db, dk, householdId, id);
  if (!created) throw new Error('unreachable: budget just inserted');
  return created;
}

export async function updateBudget(
  db: Db,
  dk: DataKey,
  householdId: string,
  id: string,
  patch: { [K in keyof BudgetInput]?: BudgetInput[K] | undefined },
): Promise<Budget | null> {
  const set: Partial<typeof budgets.$inferInsert> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.categoryIds !== undefined) set.categoryIds = [...new Set(patch.categoryIds)];
  if (patch.periodKind !== undefined) set.periodKind = patch.periodKind;
  if (patch.amount !== undefined) {
    set.amountMinorEnc = encryptField(dk, patch.amount.minor.toString(), amountAad(id));
    set.currency = patch.amount.currency;
  }
  const updated = await db
    .update(budgets)
    .set(set)
    .where(
      and(eq(budgets.id, id), eq(budgets.householdId, householdId), eq(budgets.archived, false)),
    )
    .returning({ id: budgets.id });
  return updated.length === 0 ? null : getBudget(db, dk, householdId, id);
}

/** Archives instead of deleting (history stays); false when the budget is unknown or already archived. */
export async function archiveBudget(db: Db, householdId: string, id: string): Promise<boolean> {
  const rows = await db
    .update(budgets)
    .set({ archived: true })
    .where(
      and(eq(budgets.id, id), eq(budgets.householdId, householdId), eq(budgets.archived, false)),
    )
    .returning({ id: budgets.id });
  return rows.length > 0;
}

// ---------------------------------------------------------------------------------------------------
// Periods

/** `YYYY-MM-DD` of an instant in a time zone. */
export function localDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/** Booking-date range of a period: `from` inclusive, `to` exclusive (local dates). */
export function periodDates(period: Period, timeZone: string): { from: string; to: string } {
  return { from: localDate(period.start, timeZone), to: localDate(period.end, timeZone) };
}

const DAY_MS = 86_400_000;

/** Parses `2026-11` or `2026-W46` into its period, or null when the key is not a real period. */
export function periodFromKey(key: string, timeZone: string): Period | null {
  const month = /^(\d{4})-(\d{2})$/.exec(key);
  if (month) {
    const instant = new Date(Date.UTC(Number(month[1]), Number(month[2]) - 1, 15, 12));
    const p = periodFor(instant, 'monthly', timeZone);
    return p.key === key ? p : null;
  }
  const week = /^(\d{4})-W(\d{2})$/.exec(key);
  if (week) {
    const jan4 = Date.UTC(Number(week[1]), 0, 4, 12);
    const monday = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY_MS;
    const p = periodFor(new Date(monday + (Number(week[2]) - 1) * 7 * DAY_MS), 'weekly', timeZone);
    return p.key === key ? p : null;
  }
  return null;
}

/**
 * The period of `kind` a request refers to. `current`/`previous` are relative to now per kind; an explicit
 * key selects that period when its kind matches, otherwise the period of `kind` containing its start.
 */
export function resolvePeriod(
  spec: string,
  kind: PeriodKind,
  now: Date,
  timeZone: string,
): Period | null {
  if (spec === 'current') return periodFor(now, kind, timeZone);
  if (spec === 'previous') return previousPeriod(periodFor(now, kind, timeZone), timeZone);
  const keyed = periodFromKey(spec, timeZone);
  if (!keyed) return null;
  return keyed.kind === kind ? keyed : periodFor(keyed.start, kind, timeZone);
}

export function periodView(p: Period) {
  return { key: p.key, start: p.start.toISOString(), end: p.end.toISOString() };
}

// ---------------------------------------------------------------------------------------------------
// Spending

export interface SpendEntry {
  categoryId: string | null;
  amount: Money;
  bookingDate: string;
}

export interface RowFilter {
  householdId: string;
  from: string;
  to: string;
  /** Only accounts with `counts_toward_budgets` (budgets) ... */
  countingOnly: boolean;
  /** ... or exactly these (the caller's visible accounts). */
  accountIds?: readonly string[];
}

/**
 * Booked + pending transactions of a period, without transfer pairs, expanded to their category parts:
 * a transaction with splits contributes only its split parts (the parent category is ignored).
 */
export async function loadSpendEntries(
  db: Db,
  dk: DataKey,
  filter: RowFilter,
): Promise<SpendEntry[]> {
  if (filter.accountIds && filter.accountIds.length === 0) return [];
  const conds = [
    eq(accounts.householdId, filter.householdId),
    gte(transactions.bookingDate, filter.from),
    lt(transactions.bookingDate, filter.to),
    isNull(transactions.transferGroupId),
  ];
  if (filter.countingOnly) conds.push(eq(accounts.countsTowardBudgets, true));
  if (filter.accountIds) conds.push(inArray(accounts.id, [...filter.accountIds]));
  const rows = await db
    .select({ tx: transactions })
    .from(transactions)
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(and(...conds));
  if (rows.length === 0) return [];

  const splitRows = await db
    .select({ split: transactionSplits })
    .from(transactionSplits)
    .innerJoin(transactions, eq(transactionSplits.transactionId, transactions.id))
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(and(...conds));
  const splitsByTx = new Map<string, Split[]>();
  for (const { split } of splitRows) {
    const list = splitsByTx.get(split.transactionId) ?? [];
    list.push({
      id: split.id,
      transactionId: split.transactionId,
      categoryId: split.categoryId,
      amountMinor: BigInt(decryptString(dk, split.amountEnc, splitAad(split.id))),
    });
    splitsByTx.set(split.transactionId, list);
  }

  const entries: SpendEntry[] = [];
  for (const { tx: row } of rows) {
    const tx = toTransaction(dk, row);
    const parts = splitsByTx.get(tx.id);
    if (parts && parts.length > 0) {
      for (const p of parts) {
        entries.push({
          categoryId: p.categoryId,
          amount: money(p.amountMinor, tx.currency),
          bookingDate: tx.bookingDate,
        });
      }
    } else {
      entries.push({
        categoryId: tx.categoryId,
        amount: money(tx.amountMinor, tx.currency),
        bookingDate: tx.bookingDate,
      });
    }
  }
  return entries;
}

/** Sums entries in `base`, negated (spending positive); entries without an FX rate are left out and flagged. */
export async function spentOf(
  entries: readonly SpendEntry[],
  base: string,
  fx: FxConverter,
): Promise<{ total: bigint; fxMissing: boolean }> {
  let total = 0n;
  let fxMissing = false;
  for (const e of entries) {
    try {
      total -= (await fx.convert(e.amount, e.bookingDate, base)).minor;
    } catch (err) {
      if (!(err instanceof FxRateMissingError)) throw err;
      fxMissing = true;
    }
  }
  return { total, fxMissing };
}

type CategoryRow = typeof categories.$inferSelect;

export interface ClassifiedSpend {
  /** Spending entries by category id (null: uncategorized); transfers and income are not in here. */
  spending: Map<string | null, SpendEntry[]>;
  incomeEntries: SpendEntry[];
  /** Positive amounts without a category (deposits not yet classified). */
  uncategorizedIncomeEntries: SpendEntry[];
}

/**
 * The one rule set that sorts entries into spending, income and uncategorized income: transfer categories
 * are skipped, income categories and uncategorized positive amounts are income, everything else is spending.
 */
export function classifySpend(
  entries: readonly SpendEntry[],
  cats: readonly CategoryRow[],
): ClassifiedSpend {
  const byId = new Map(cats.map((c) => [c.id, c]));
  const spending = new Map<string | null, SpendEntry[]>();
  const incomeEntries: SpendEntry[] = [];
  const uncategorizedIncomeEntries: SpendEntry[] = [];
  for (const e of entries) {
    const cat = e.categoryId === null ? undefined : byId.get(e.categoryId);
    if (cat?.isTransfer) continue;
    if (cat?.isIncome) {
      incomeEntries.push(e);
      continue;
    }
    if (!cat && e.amount.minor > 0n) {
      uncategorizedIncomeEntries.push(e);
      continue;
    }
    const key = cat ? cat.id : null;
    spending.set(key, [...(spending.get(key) ?? []), e]);
  }
  return { spending, incomeEntries, uncategorizedIncomeEntries };
}

export interface SpentResult {
  /** Raw spent in the budget currency: refunds reduce it, so it can be negative. */
  spent: Money;
  fxMissing: boolean;
}

/**
 * Spent of a budget in a period, computed once per household: every account of the household with
 * `counts_toward_budgets`, regardless of who asks and of visibility (an `owner_only` account may count).
 * This is a deliberate household-wide read, not a per-caller one; only the totals leave this function.
 */
export async function spentFor(
  db: Db,
  dk: DataKey,
  budget: Budget,
  period: Period,
  settings: HouseholdSettings,
  fx: FxConverter = createFxConverter(db),
): Promise<SpentResult> {
  const { from, to } = periodDates(period, settings.timezone);
  const entries = await loadSpendEntries(db, dk, {
    householdId: budget.householdId,
    from,
    to,
    countingOnly: true,
  });
  const wanted = new Set(budget.categoryIds);
  const matching = entries.filter((e) => e.categoryId !== null && wanted.has(e.categoryId));
  const { total, fxMissing } = await spentOf(matching, budget.amount.currency, fx);
  return { spent: money(total, budget.amount.currency), fxMissing };
}

/** `max(0, spent) / amount` with four decimals (half-even), as a string like "0.6800". */
export function ratioString(spent: Money, amount: Money): string {
  const clamped = spent.minor > 0n ? spent.minor : 0n;
  const scaled = clamped * 10_000n;
  let q = scaled / amount.minor;
  const twiceRem = (scaled % amount.minor) * 2n;
  if (twiceRem > amount.minor || (twiceRem === amount.minor && q % 2n === 1n)) q += 1n;
  const digits = q.toString().padStart(5, '0');
  return `${digits.slice(0, -4)}.${digits.slice(-4)}`;
}

export async function budgetViews(
  db: Db,
  dk: DataKey,
  householdId: string,
  now: Date,
  periodSpec: string,
  settings: HouseholdSettings,
): Promise<{ views: BudgetView[]; fxMissing: boolean }> {
  const fx = createFxConverter(db);
  const list = await listBudgets(db, dk, householdId);
  const views: BudgetView[] = [];
  let fxMissing = false;
  for (const b of list) {
    const period = resolvePeriod(periodSpec, b.periodKind, now, settings.timezone);
    if (!period) throw new Error('Invalid period');
    const result = await spentFor(db, dk, b, period, settings, fx);
    fxMissing ||= result.fxMissing;
    views.push(toView(b, period, result));
  }
  return { views, fxMissing };
}

export function toView(b: Budget, period: Period, result: SpentResult): BudgetView {
  return {
    id: b.id,
    name: b.name,
    categoryIds: b.categoryIds,
    periodKind: b.periodKind,
    amount: toJSON(b.amount),
    spent: toJSON(result.spent),
    ratio: ratioString(result.spent, b.amount),
    fxMissing: result.fxMissing,
    period: periodView(period),
  };
}

/** Local dates `from` (inclusive) to `to` (exclusive), as `YYYY-MM-DD`. */
function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t < Date.parse(`${to}T00:00:00Z`); t += DAY_MS) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

export interface DailySpent {
  /** Household-timezone calendar day, `YYYY-MM-DD`. */
  date: string;
  /** Net spending of that day in the base currency (refunds can make it negative). */
  spent: Money;
}

export interface Breakdown {
  breakdown: {
    categoryId: string | null;
    name: string;
    spent: Money;
    /** Raw stored values (null for uncategorized or unset); the client resolves fallbacks. */
    icon: string | null;
    color: string | null;
  }[];
  /**
   * Spending per calendar day from the period start through `min(today, last day)`, zeros included; the
   * entries of the categories shown in the breakdown (visible accounts, no transfers/income; categories
   * with net spent <= 0 are left out, bookings dated after today count on today), so it sums to its total.
   */
  daily: DailySpent[];
  income: Money;
  /** Positive amounts without a category (deposits not yet classified); not part of the breakdown. */
  uncategorizedIncome: Money;
  fxMissing: boolean;
}

/**
 * Where the money went, over the caller's visible accounts only: spending categories (not income, not
 * transfer; transfer-grouped transactions are excluded), largest first, refunds netted into their category.
 * Categories whose net spent is zero or negative are omitted. Income is reported separately, and so are
 * uncategorized positive amounts (`uncategorizedIncome`) so they cannot distort the Uncategorized row.
 */
export async function breakdownFor(
  db: Db,
  dk: DataKey,
  visible: VisibleAccountIds,
  householdId: string,
  period: Period,
  settings: HouseholdSettings,
  now: Date,
): Promise<Breakdown> {
  const { from, to } = periodDates(period, settings.timezone);
  const entries = await loadSpendEntries(db, dk, {
    householdId,
    from,
    to,
    countingOnly: false,
    accountIds: visible,
  });
  const cats = await db.select().from(categories).where(eq(categories.householdId, householdId));
  const byId = new Map(cats.map((c) => [c.id, c]));
  const fx = createFxConverter(db);
  const base = settings.baseCurrency;

  const { spending, incomeEntries, uncategorizedIncomeEntries } = classifySpend(entries, cats);

  let fxMissing = false;
  const breakdown: Breakdown['breakdown'] = [];
  const today = localDate(now, settings.timezone);
  // Only categories shown in the breakdown feed `daily`, so both always total the same. bookingDate is
  // already a household-timezone day; bookings dated after today count on today.
  const spendingByDay = new Map<string, SpendEntry[]>();
  for (const [categoryId, list] of spending) {
    const r = await spentOf(list, base, fx);
    fxMissing ||= r.fxMissing;
    if (r.total <= 0n) continue;
    for (const e of list) {
      const day = e.bookingDate > today ? today : e.bookingDate;
      spendingByDay.set(day, [...(spendingByDay.get(day) ?? []), e]);
    }
    breakdown.push({
      categoryId,
      name: categoryId === null ? 'Uncategorized' : (byId.get(categoryId)?.name ?? 'Uncategorized'),
      spent: money(r.total, base),
      icon: categoryId === null ? null : (byId.get(categoryId)?.icon ?? null),
      color: categoryId === null ? null : (byId.get(categoryId)?.color ?? null),
    });
  }
  const daily: DailySpent[] = [];
  for (const date of daysBetween(from, to)) {
    if (date > today) break;
    const r = await spentOf(spendingByDay.get(date) ?? [], base, fx);
    fxMissing ||= r.fxMissing;
    daily.push({ date, spent: money(r.total, base) });
  }
  breakdown.sort((a, b) =>
    a.spent.minor === b.spent.minor
      ? a.name.localeCompare(b.name)
      : a.spent.minor > b.spent.minor
        ? -1
        : 1,
  );
  const inc = await spentOf(incomeEntries, base, fx);
  fxMissing ||= inc.fxMissing;
  const unc = await spentOf(uncategorizedIncomeEntries, base, fx);
  fxMissing ||= unc.fxMissing;
  return {
    breakdown,
    daily,
    income: money(-inc.total, base),
    uncategorizedIncome: money(-unc.total, base),
    fxMissing,
  };
}

export interface StatisticsMonth {
  key: string;
  start: string;
  end: string;
  partial: boolean;
  income: Money;
  spending: Money;
}

export interface Statistics {
  months: StatisticsMonth[];
  averageKept: Money | null;
  categories: {
    categoryId: string | null;
    name: string;
    icon: string | null;
    color: string | null;
    spent: Money;
    previousSpent: Money;
  }[];
  fxMissing: boolean;
}

/** Net spend per category (spending categories only), unclamped. */
async function netByCategory(
  spending: Map<string | null, SpendEntry[]>,
  base: string,
  fx: FxConverter,
  flag: { fxMissing: boolean },
): Promise<Map<string | null, bigint>> {
  const out = new Map<string | null, bigint>();
  for (const [id, list] of spending) {
    const r = await spentOf(list, base, fx);
    flag.fxMissing ||= r.fxMissing;
    out.set(id, r.total);
  }
  return out;
}

/** Rounds `sum / n` half away from zero (integer minor units). */
function divRound(sum: bigint, n: bigint): bigint {
  const abs = sum < 0n ? -sum : sum;
  const q = (abs * 2n + n) / (2n * n);
  return sum < 0n ? -q : q;
}

/**
 * Month-by-month income/spending over the viewer's visible accounts for the current month plus the
 * `monthCount - 1` before it, and per-category spend of the window versus the `monthCount` months before.
 * Uses the same classification and per-category net > 0 rule as the home breakdown. Months before the
 * month of the first visible transaction are omitted.
 */
export async function statisticsFor(
  db: Db,
  dk: DataKey,
  visible: VisibleAccountIds,
  householdId: string,
  monthCount: number,
  settings: HouseholdSettings,
  now: Date,
): Promise<Statistics> {
  const tz = settings.timezone;
  const base = settings.baseCurrency;
  const periods: Period[] = [];
  let p = periodFor(now, 'monthly', tz);
  const currentKey = p.key;
  for (let i = 0; i < monthCount * 2; i++) {
    periods.unshift(p);
    p = previousPeriod(p, tz);
  }
  const window = periods.slice(monthCount);
  const lastEnd = window[window.length - 1];
  const firstStart = periods[0];
  if (!lastEnd || !firstStart) throw new Error('unreachable: at least one month');

  const empty: Statistics = { months: [], averageKept: null, categories: [], fxMissing: false };
  if (visible.length === 0) return empty;
  const [first] = await db
    .select({ min: sql<string | null>`min(${transactions.bookingDate})` })
    .from(transactions)
    .where(inArray(transactions.accountId, [...visible]));
  if (!first?.min) return empty;
  const firstKey = first.min.slice(0, 7);

  const entries = await loadSpendEntries(db, dk, {
    householdId,
    from: localDate(firstStart.start, tz),
    to: localDate(lastEnd.end, tz),
    countingOnly: false,
    accountIds: visible,
  });
  const cats = await db.select().from(categories).where(eq(categories.householdId, householdId));
  const byId = new Map(cats.map((c) => [c.id, c]));
  const fx = createFxConverter(db);
  const flag = { fxMissing: false };

  const byMonth = new Map<string, SpendEntry[]>();
  for (const e of entries) {
    const key = e.bookingDate.slice(0, 7);
    byMonth.set(key, [...(byMonth.get(key) ?? []), e]);
  }

  const months: StatisticsMonth[] = [];
  let keptSum = 0n;
  let complete = 0n;
  for (const period of window) {
    if (period.key < firstKey) continue;
    const c = classifySpend(byMonth.get(period.key) ?? [], cats);
    let spending = 0n;
    for (const total of (await netByCategory(c.spending, base, fx, flag)).values()) {
      if (total > 0n) spending += total;
    }
    const inc = await spentOf([...c.incomeEntries, ...c.uncategorizedIncomeEntries], base, fx);
    flag.fxMissing ||= inc.fxMissing;
    const income = -inc.total;
    const partial = period.key === currentKey;
    if (!partial) {
      keptSum += income - spending;
      complete += 1n;
    }
    months.push({
      ...periodView(period),
      partial,
      income: money(income, base),
      spending: money(spending, base),
    });
  }

  const windowStartKey = window[0]?.key ?? currentKey;
  const inWindow = (e: SpendEntry) => e.bookingDate.slice(0, 7) >= windowStartKey;
  const current = await netByCategory(
    classifySpend(entries.filter(inWindow), cats).spending,
    base,
    fx,
    flag,
  );
  const previous = await netByCategory(
    classifySpend(
      entries.filter((e) => !inWindow(e)),
      cats,
    ).spending,
    base,
    fx,
    flag,
  );
  const clamp = (v: bigint | undefined) => (v !== undefined && v > 0n ? v : 0n);
  const categoryRows: Statistics['categories'] = [];
  for (const id of new Set([...current.keys(), ...previous.keys()])) {
    const spent = clamp(current.get(id));
    const previousSpent = clamp(previous.get(id));
    if (spent === 0n && previousSpent === 0n) continue;
    const cat = id === null ? undefined : byId.get(id);
    categoryRows.push({
      categoryId: id,
      name: cat?.name ?? 'Uncategorized',
      icon: cat?.icon ?? null,
      color: cat?.color ?? null,
      spent: money(spent, base),
      previousSpent: money(previousSpent, base),
    });
  }
  categoryRows.sort((a, b) =>
    a.spent.minor === b.spent.minor
      ? a.name.localeCompare(b.name)
      : a.spent.minor > b.spent.minor
        ? -1
        : 1,
  );

  return {
    months,
    averageKept: complete > 0n ? money(divRound(keptSum, complete), base) : null,
    categories: categoryRows,
    fxMissing: flag.fxMissing,
  };
}

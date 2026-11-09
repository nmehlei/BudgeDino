import { and, eq, gte, inArray, isNull, lte } from 'drizzle-orm';
import { decryptString, type DataKey } from '../crypto/index.js';
import type { Db } from '../db/client.js';
import { newId } from '../db/ids.js';
import { accounts, categories, connectors, transactions } from '../db/schema.js';
import type { Keyring } from '../households/keyring.js';
import { toTransaction, type Transaction } from '../repositories/transactions.js';
import { householdTransactionRows } from './rules.js';

/** Opposite amounts on two accounts count as one transfer when booked at most this many days apart. */
export const TRANSFER_WINDOW_DAYS = 4;

const DAY_MS = 86_400_000;
const dayNumber = (isoDate: string) => Date.parse(`${isoDate}T00:00:00Z`) / DAY_MS;
const shiftDate = (isoDate: string, days: number) =>
  new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const normIban = (s: string | null) => (s === null ? null : s.replaceAll(/\s+/g, '').toUpperCase());

interface Pair {
  a: Transaction;
  b: Transaction;
  ibanMatch: boolean;
  gap: number;
}

async function accountIbans(db: Db, dk: DataKey, householdId: string) {
  const rows = await db
    .select({ id: accounts.id, ibanEnc: accounts.ibanEnc })
    .from(accounts)
    .innerJoin(connectors, eq(accounts.connectorId, connectors.id))
    .where(eq(connectors.householdId, householdId));
  const map = new Map<string, string | null>();
  for (const r of rows) {
    map.set(
      r.id,
      r.ibanEnc
        ? normIban(decryptString(dk, r.ibanEnc, { table: 'accounts', column: 'iban', rowId: r.id }))
        : null,
    );
  }
  return map;
}

/**
 * Pairs opposite amounts (same currency and absolute value, different accounts of the household, booked
 * within {@link TRANSFER_WINDOW_DAYS}) among the household's unpaired booked transactions, seeded by
 * `txIds`. Considers every household account, `owner_only` ones included, so a transfer into a hidden
 * account is still excluded from spending; visibility of the pair is decided by the normal gate on read.
 *
 * Candidates are ranked: counterparty IBAN equal to the other account's IBAN first, then the smallest date
 * gap, then ids; each transaction ends up in at most one pair. Both rows get a shared `transfer_group_id`
 * and, unless manually categorized, the household's Transfer category with source `rule`.
 */
export async function detectTransfers(
  db: Db,
  keyring: Keyring,
  householdId: string,
  txIds: readonly string[],
): Promise<void> {
  if (txIds.length === 0) return;
  const dk = await keyring.forHousehold(householdId);
  const seedRows = await householdTransactionRows(db, householdId).where(
    and(
      eq(connectors.householdId, householdId),
      inArray(transactions.id, [...txIds]),
      eq(transactions.status, 'booked'),
      isNull(transactions.transferGroupId),
    ),
  );
  const seeds = seedRows.map((r) => toTransaction(dk, r.tx)).filter((t) => t.amountMinor !== 0n);
  if (seeds.length === 0) return;

  const dates = seeds.map((s) => s.bookingDate).sort();
  const lo = shiftDate(dates[0] as string, -TRANSFER_WINDOW_DAYS);
  const hi = shiftDate(dates[dates.length - 1] as string, TRANSFER_WINDOW_DAYS);
  const poolRows = await householdTransactionRows(db, householdId).where(
    and(
      eq(connectors.householdId, householdId),
      eq(transactions.status, 'booked'),
      isNull(transactions.transferGroupId),
      gte(transactions.bookingDate, lo),
      lte(transactions.bookingDate, hi),
    ),
  );
  const pool = poolRows.map((r) => toTransaction(dk, r.tx)).filter((t) => t.amountMinor !== 0n);
  const ibans = await accountIbans(db, dk, householdId);

  const pairs = new Map<string, Pair>();
  for (const s of seeds) {
    for (const c of pool) {
      if (c.id === s.id || c.accountId === s.accountId || c.currency !== s.currency) continue;
      if (c.amountMinor !== -s.amountMinor) continue;
      const gap = Math.abs(dayNumber(c.bookingDate) - dayNumber(s.bookingDate));
      if (gap > TRANSFER_WINDOW_DAYS) continue;
      const [a, b] = s.id < c.id ? [s, c] : [c, s];
      const key = `${a.id}|${b.id}`;
      if (pairs.has(key)) continue;
      const aIban = ibans.get(a.accountId) ?? null;
      const bIban = ibans.get(b.accountId) ?? null;
      const ibanMatch =
        (aIban !== null && normIban(b.counterpartyIban) === aIban) ||
        (bIban !== null && normIban(a.counterpartyIban) === bIban);
      pairs.set(key, { a, b, ibanMatch, gap });
    }
  }

  const ranked = [...pairs.values()].sort(
    (p, q) =>
      Number(q.ibanMatch) - Number(p.ibanMatch) ||
      p.gap - q.gap ||
      (p.a.id + p.b.id < q.a.id + q.b.id ? -1 : 1),
  );
  const used = new Set<string>();
  const chosen: Pair[] = [];
  for (const p of ranked) {
    if (used.has(p.a.id) || used.has(p.b.id)) continue;
    used.add(p.a.id);
    used.add(p.b.id);
    chosen.push(p);
  }
  if (chosen.length === 0) return;

  const [transferCategory] = await db
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.householdId, householdId), eq(categories.isTransfer, true)));

  for (const p of chosen) {
    const groupId = newId();
    await db
      .transaction(async (trx) => {
        for (const t of [p.a, p.b]) {
          const manual = t.categorySource === 'manual';
          const updated = await trx
            .update(transactions)
            .set({
              transferGroupId: groupId,
              ...(manual || !transferCategory
                ? {}
                : {
                    categoryId: transferCategory.id,
                    categorySource: 'rule' as const,
                    categorySetAt: new Date(),
                  }),
            })
            .where(and(eq(transactions.id, t.id), isNull(transactions.transferGroupId)))
            .returning({ id: transactions.id });
          // Lost a race with a concurrent detection: leave both rows to the winner.
          if (updated.length === 0) throw new PairTaken();
        }
      })
      .catch((err: unknown) => {
        if (!(err instanceof PairTaken)) throw err;
      });
  }
}

class PairTaken extends Error {}

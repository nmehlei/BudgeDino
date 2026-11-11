import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, or } from 'drizzle-orm';
import { blindIndex, decryptString, encryptField, type DataKey } from '../crypto/index.js';
import type { Db } from '../db/client.js';
import { newId } from '../db/ids.js';
import { transactionSplits, transactions } from '../db/schema.js';
import type { VisibleAccountIds } from '../access/visibility.js';

const aad = (column: string, rowId: string) => ({ table: 'transactions', column, rowId });

export interface NewTransaction {
  accountId: string;
  /** Stable per-account identity of the booking (bank reference or content hash); stored as blind index. */
  dedupKey: string;
  status: 'pending' | 'booked';
  bookingDate: string;
  valueDate?: string;
  /** Signed integer minor units (negative = outflow). */
  amountMinor: bigint;
  currency: string;
  counterparty?: string;
  counterpartyIban?: string;
  purpose?: string;
  mcc?: string;
}

export interface Transaction {
  id: string;
  accountId: string;
  status: 'pending' | 'booked';
  bookingDate: string;
  valueDate: string | null;
  amountMinor: bigint;
  currency: string;
  counterparty: string | null;
  counterpartyIban: string | null;
  counterpartyBidx: string | null;
  purpose: string | null;
  mcc: string | null;
  categoryId: string | null;
  categorySource: 'rule' | 'learned' | 'heuristic' | 'manual' | 'none';
  transferGroupId: string | null;
}

export async function createTransaction(
  db: Db,
  dk: DataKey,
  input: NewTransaction,
): Promise<string> {
  const id = newId();
  await db.insert(transactions).values({
    id,
    accountId: input.accountId,
    dedupBidx: blindIndex(dk, 'tx-dedup', input.dedupKey),
    status: input.status,
    bookingDate: input.bookingDate,
    valueDate: input.valueDate ?? null,
    amountEnc: encryptField(dk, input.amountMinor.toString(), aad('amount', id)),
    currency: input.currency,
    counterpartyEnc:
      input.counterparty === undefined
        ? null
        : encryptField(dk, input.counterparty, aad('counterparty', id)),
    counterpartyBidx:
      input.counterparty === undefined
        ? null
        : blindIndex(dk, 'tx-counterparty', input.counterparty.trim().toLowerCase()),
    counterpartyIbanEnc:
      input.counterpartyIban === undefined
        ? null
        : encryptField(dk, input.counterpartyIban, aad('counterparty_iban', id)),
    purposeEnc:
      input.purpose === undefined ? null : encryptField(dk, input.purpose, aad('purpose', id)),
    mcc: input.mcc ?? null,
  });
  return id;
}

export function toTransaction(dk: DataKey, row: typeof transactions.$inferSelect): Transaction {
  return {
    id: row.id,
    accountId: row.accountId,
    status: row.status,
    bookingDate: row.bookingDate,
    valueDate: row.valueDate,
    amountMinor: BigInt(decryptString(dk, row.amountEnc, aad('amount', row.id))),
    currency: row.currency,
    counterparty: row.counterpartyEnc
      ? decryptString(dk, row.counterpartyEnc, aad('counterparty', row.id))
      : null,
    counterpartyIban: row.counterpartyIbanEnc
      ? decryptString(dk, row.counterpartyIbanEnc, aad('counterparty_iban', row.id))
      : null,
    counterpartyBidx: row.counterpartyBidx,
    purpose: row.purposeEnc ? decryptString(dk, row.purposeEnc, aad('purpose', row.id)) : null,
    mcc: row.mcc,
    categoryId: row.categoryId,
    categorySource: row.categorySource,
    transferGroupId: row.transferGroupId,
  };
}

/** Reads one transaction; one on an account outside `visible` is indistinguishable from a missing one. */
export async function getTransaction(
  db: Db,
  dk: DataKey,
  visible: VisibleAccountIds,
  id: string,
): Promise<Transaction> {
  if (visible.length === 0) throw new Error('Transaction not found');
  const [row] = await db
    .select()
    .from(transactions)
    .where(and(eq(transactions.id, id), inArray(transactions.accountId, [...visible])));
  if (!row) throw new Error('Transaction not found');
  return toTransaction(dk, row);
}

/** Lists transactions of the visible accounts, optionally narrowed to one account. */
export async function listTransactions(
  db: Db,
  dk: DataKey,
  visible: VisibleAccountIds,
  accountId?: string,
): Promise<Transaction[]> {
  const ids = accountId === undefined ? [...visible] : visible.filter((v) => v === accountId);
  if (ids.length === 0) return [];
  const rows = await db
    .select()
    .from(transactions)
    .where(inArray(transactions.accountId, ids))
    .orderBy(asc(transactions.bookingDate), asc(transactions.id));
  return rows.map((row) => toTransaction(dk, row));
}

export interface TransactionQuery {
  from?: string | undefined;
  to?: string | undefined;
  accountId?: string | undefined;
  categoryId?: string | undefined;
  /** Only transactions without a category (`category_id IS NULL`). */
  uncategorized?: boolean | undefined;
  /** Case-insensitive substring of counterparty or purpose (scans decrypted rows, see `SEARCH_SCAN_CAP`). */
  q?: string | undefined;
  /** Opaque keyset cursor from a previous page. */
  cursor?: string | undefined;
  limit: number;
}

export interface TransactionPage {
  items: Transaction[];
  nextCursor: string | null;
  /** Search only: booking date of the last scanned row when more remains; null otherwise (always null without `q`). */
  scannedUntil: string | null;
}

/** Maximum rows a single search request scans before returning what it found. */
export const SEARCH_SCAN_CAP = 5000;
/** Rows fetched and decrypted per search batch. */
export const SEARCH_BATCH = 500;

const searchFold = (value: string) => value.toLocaleLowerCase('de-DE');

function baseConditions(ids: string[], q: TransactionQuery) {
  const conds = [inArray(transactions.accountId, ids)];
  if (q.from !== undefined) conds.push(gte(transactions.bookingDate, q.from));
  if (q.to !== undefined) conds.push(lte(transactions.bookingDate, q.to));
  if (q.categoryId !== undefined) conds.push(eq(transactions.categoryId, q.categoryId));
  if (q.uncategorized === true) conds.push(isNull(transactions.categoryId));
  return conds;
}

function afterCursor(cursor: string) {
  const [date, id] = cursor.split('|');
  if (date === undefined || id === undefined) throw new Error('Invalid cursor');
  return or(
    lt(transactions.bookingDate, date),
    and(eq(transactions.bookingDate, date), lt(transactions.id, id)),
  );
}

/** Keyset order: newest booking date first, id as tie-breaker. Cursor = `<bookingDate>|<id>`. */
export async function queryTransactions(
  db: Db,
  dk: DataKey,
  visible: VisibleAccountIds,
  q: TransactionQuery,
): Promise<TransactionPage> {
  const ids = q.accountId === undefined ? [...visible] : visible.filter((v) => v === q.accountId);
  if (ids.length === 0) return { items: [], nextCursor: null, scannedUntil: null };
  const conds = baseConditions(ids, q);
  if (q.q !== undefined) return searchTransactions(db, dk, conds, q.q, q.cursor, q.limit);
  if (q.cursor !== undefined) {
    const after = afterCursor(q.cursor);
    if (after) conds.push(after);
  }
  const rows = await db
    .select()
    .from(transactions)
    .where(and(...conds))
    .orderBy(desc(transactions.bookingDate), desc(transactions.id))
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    items: page.map((row) => toTransaction(dk, row)),
    nextCursor: rows.length > q.limit && last ? `${last.bookingDate}|${last.id}` : null,
    scannedUntil: null,
  };
}

/** Counterparty and purpose are encrypted, so the scan decrypts keyset batches and filters in memory. */
async function searchTransactions(
  db: Db,
  dk: DataKey,
  conds: ReturnType<typeof baseConditions>,
  query: string,
  startCursor: string | undefined,
  limit: number,
): Promise<TransactionPage> {
  const needle = searchFold(query);
  const items: Transaction[] = [];
  let cursor = startCursor;
  let scanned = 0;
  while (scanned < SEARCH_SCAN_CAP) {
    const batchConds = [...conds];
    if (cursor !== undefined) {
      const after = afterCursor(cursor);
      if (after) batchConds.push(after);
    }
    const rows = await db
      .select()
      .from(transactions)
      .where(and(...batchConds))
      .orderBy(desc(transactions.bookingDate), desc(transactions.id))
      .limit(SEARCH_BATCH);
    for (const [i, row] of rows.entries()) {
      scanned += 1;
      const tx = toTransaction(dk, row);
      const hit =
        (tx.counterparty !== null && searchFold(tx.counterparty).includes(needle)) ||
        (tx.purpose !== null && searchFold(tx.purpose).includes(needle));
      if (hit) items.push(tx);
      cursor = `${row.bookingDate}|${row.id}`;
      if (items.length >= limit) {
        // the scan may continue after this row unless it was the very last one
        const exhausted = rows.length < SEARCH_BATCH && i === rows.length - 1;
        return exhausted
          ? { items, nextCursor: null, scannedUntil: null }
          : { items, nextCursor: cursor, scannedUntil: row.bookingDate };
      }
    }
    if (rows.length < SEARCH_BATCH) return { items, nextCursor: null, scannedUntil: null };
  }
  const [date] = (cursor ?? '').split('|');
  return { items, nextCursor: cursor ?? null, scannedUntil: date ?? null };
}

export interface Split {
  id: string;
  transactionId: string;
  categoryId: string | null;
  amountMinor: bigint;
}

const splitAad = (rowId: string) => ({ table: 'transaction_splits', column: 'amount', rowId });

/** Splits of transactions the caller can see (the transactions must come from a visible read). */
export async function listSplits(
  db: Db,
  dk: DataKey,
  _visible: VisibleAccountIds,
  transactionIds: readonly string[],
): Promise<Split[]> {
  if (transactionIds.length === 0) return [];
  const rows = await db
    .select()
    .from(transactionSplits)
    .where(inArray(transactionSplits.transactionId, [...transactionIds]))
    .orderBy(asc(transactionSplits.id));
  return rows.map((r) => ({
    id: r.id,
    transactionId: r.transactionId,
    categoryId: r.categoryId,
    amountMinor: BigInt(decryptString(dk, r.amountEnc, splitAad(r.id))),
  }));
}

/** Replaces all splits of a (visible) transaction atomically. */
export async function replaceSplits(
  db: Db,
  dk: DataKey,
  visible: VisibleAccountIds,
  transactionId: string,
  parts: readonly { categoryId: string; amountMinor: bigint }[],
): Promise<void> {
  await getTransaction(db, dk, visible, transactionId);
  await db.transaction(async (tx) => {
    await tx.delete(transactionSplits).where(eq(transactionSplits.transactionId, transactionId));
    for (const part of parts) {
      const id = newId();
      await tx.insert(transactionSplits).values({
        id,
        transactionId,
        categoryId: part.categoryId,
        amountEnc: encryptField(dk, part.amountMinor.toString(), splitAad(id)),
      });
    }
  });
}

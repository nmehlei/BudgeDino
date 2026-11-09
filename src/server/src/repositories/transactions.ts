import { and, asc, eq, inArray } from 'drizzle-orm';
import { blindIndex, decryptString, encryptField, type DataKey } from '../crypto/index.js';
import type { Db } from '../db/client.js';
import { newId } from '../db/ids.js';
import { transactions } from '../db/schema.js';
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
  purpose: string | null;
  mcc: string | null;
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
    purposeEnc:
      input.purpose === undefined ? null : encryptField(dk, input.purpose, aad('purpose', id)),
    mcc: input.mcc ?? null,
  });
  return id;
}

function toTransaction(dk: DataKey, row: typeof transactions.$inferSelect): Transaction {
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
    purpose: row.purposeEnc ? decryptString(dk, row.purposeEnc, aad('purpose', row.id)) : null,
    mcc: row.mcc,
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

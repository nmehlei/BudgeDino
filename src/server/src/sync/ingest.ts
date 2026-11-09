import { createHash } from 'node:crypto';
import { and, eq, inArray, lt } from 'drizzle-orm';
import { blindIndex, decryptString, encryptField, type DataKey } from '../crypto/index.js';
import type { DbOrTx } from '../db/client.js';
import { newId } from '../db/ids.js';
import { transactionDedupAliases, transactionSplits, transactions } from '../db/schema.js';
import type { ProviderTransaction } from '../connectors/types.js';

const aad = (column: string, rowId: string) => ({ table: 'transactions', column, rowId });

const DAY_MS = 86_400_000;
/** A booked transaction may settle up to this long after its pending counterpart. */
const RECONCILE_WINDOW_DAYS = 7;
/** Pending and booked amounts may differ (tips, fuel pre-auths) by up to this share of the pending amount. */
const RECONCILE_AMOUNT_TOLERANCE_PERCENT = 25n;
/** Pending rows no longer reported by the bank and older than this are stale pre-authorisations. */
const STALE_PENDING_DAYS = 14;

export interface IngestResult {
  inserted: string[];
  updated: string[];
  /** Stale pending rows removed. */
  deleted: number;
}

export interface IngestOptions {
  now?: Date;
}

const normalizeCounterparty = (c: string) => c.trim().toLowerCase();
const dayNumber = (isoDate: string) => Date.parse(`${isoDate}T00:00:00Z`) / DAY_MS;

/** sha256(bookingDate|amount|currency|counterpartyIban|purpose): identity for transactions without a stable id. */
export function contentHash(tx: ProviderTransaction): string {
  return createHash('sha256')
    .update(
      [
        tx.bookingDate,
        tx.amount.minor.toString(),
        tx.amount.currency,
        tx.counterpartyIban ?? '',
        tx.purpose ?? '',
      ].join('|'),
    )
    .digest('hex');
}

type Row = typeof transactions.$inferSelect;

/**
 * Idempotent upsert of provider transactions into one account.
 *
 * Identity is the provider id when present, else a content hash (identical content repeated within
 * one batch gets an occurrence suffix, so two genuine identical payments stay two rows).
 * A booked transaction without a match takes over a pending row of the same account when counterparty,
 * amount (within 25 %) and date (within 7 days after the pending date) fit; the row keeps its id and category.
 * Pending rows older than 14 days that this batch did not mention are deleted. The dedup key of an absorbed
 * pending row stays as an alias of the booked row, so a re-reported pre-authorisation never comes back.
 */
export async function ingest(
  db: DbOrTx,
  dk: DataKey,
  accountId: string,
  txs: ProviderTransaction[],
  options: IngestOptions = {},
): Promise<IngestResult> {
  const now = options.now ?? new Date();
  const inserted: string[] = [];
  const updated: string[] = [];
  const touched = new Set<string>();
  const seenHashes = new Map<string, number>();

  // Keys are assigned in provider order (stable occurrence suffixes); processing then handles pending
  // entries before booked ones, so a pending/booked pair in one batch reconciles whatever the order.
  const keyed = txs.map((tx) => {
    let key: string;
    if (tx.providerId !== null) {
      key = `id:${tx.providerId}`;
    } else {
      const hash = contentHash(tx);
      const n = seenHashes.get(hash) ?? 0;
      seenHashes.set(hash, n + 1);
      key = n === 0 ? `hash:${hash}` : `hash:${hash}#${n}`;
    }
    return { tx, dedupBidx: blindIndex(dk, 'tx-dedup', key) };
  });
  const ordered = [
    ...keyed.filter((k) => k.tx.status === 'pending'),
    ...keyed.filter((k) => k.tx.status === 'booked'),
  ];
  const reconciled = new Set<string>();

  for (const { tx, dedupBidx } of ordered) {
    const [existing] = await db
      .select()
      .from(transactions)
      .where(and(eq(transactions.accountId, accountId), eq(transactions.dedupBidx, dedupBidx)));
    if (existing) {
      touched.add(existing.id);
      if (await updateIfChanged(db, dk, existing, tx, dedupBidx)) updated.push(existing.id);
      continue;
    }

    // A key that was absorbed into a booked row earlier: the bank is re-reporting the old pre-auth.
    const [alias] = await db
      .select({ transactionId: transactionDedupAliases.transactionId })
      .from(transactionDedupAliases)
      .where(
        and(
          eq(transactionDedupAliases.accountId, accountId),
          eq(transactionDedupAliases.dedupBidx, dedupBidx),
        ),
      );
    if (alias) {
      touched.add(alias.transactionId);
      continue;
    }

    if (tx.status === 'booked' && tx.counterparty !== undefined) {
      const match = await findPendingMatch(db, dk, accountId, tx, reconciled);
      if (match) {
        reconciled.add(match.id);
        touched.add(match.id);
        await db
          .insert(transactionDedupAliases)
          .values({ accountId, dedupBidx: match.dedupBidx, transactionId: match.id })
          .onConflictDoNothing();
        await writeTx(db, dk, match, tx, dedupBidx);
        updated.push(match.id);
        continue;
      }
    }

    const id = newId();
    await db.insert(transactions).values(buildValues(dk, id, accountId, tx, dedupBidx));
    touched.add(id);
    inserted.push(id);
  }

  const cutoff = new Date(now.getTime() - STALE_PENDING_DAYS * DAY_MS).toISOString().slice(0, 10);
  const stale = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(
      and(
        eq(transactions.accountId, accountId),
        eq(transactions.status, 'pending'),
        lt(transactions.bookingDate, cutoff),
      ),
    );
  const staleIds = stale.map((r) => r.id).filter((id) => !touched.has(id));
  if (staleIds.length > 0) {
    await db.delete(transactions).where(inArray(transactions.id, staleIds));
  }

  return { inserted, updated, deleted: staleIds.length };
}

function buildValues(
  dk: DataKey,
  id: string,
  accountId: string,
  tx: ProviderTransaction,
  dedupBidx: string,
) {
  return {
    id,
    accountId,
    dedupBidx,
    status: tx.status,
    bookingDate: tx.bookingDate,
    valueDate: tx.valueDate ?? null,
    amountEnc: encryptField(dk, tx.amount.minor.toString(), aad('amount', id)),
    currency: tx.amount.currency,
    counterpartyEnc:
      tx.counterparty === undefined
        ? null
        : encryptField(dk, tx.counterparty, aad('counterparty', id)),
    counterpartyBidx:
      tx.counterparty === undefined
        ? null
        : blindIndex(dk, 'tx-counterparty', normalizeCounterparty(tx.counterparty)),
    counterpartyIbanEnc:
      tx.counterpartyIban === undefined
        ? null
        : encryptField(dk, tx.counterpartyIban, aad('counterparty_iban', id)),
    purposeEnc: tx.purpose === undefined ? null : encryptField(dk, tx.purpose, aad('purpose', id)),
    mcc: tx.mcc ?? null,
  };
}

/**
 * Overwrites the provider-owned columns of a row; id, category and transfer group are kept. When the
 * amount or currency changes the row's splits no longer sum to it, so they are deleted (category stays).
 */
async function writeTx(
  db: DbOrTx,
  dk: DataKey,
  row: Row,
  tx: ProviderTransaction,
  dedupBidx: string,
): Promise<void> {
  const values: Partial<ReturnType<typeof buildValues>> = buildValues(
    dk,
    row.id,
    '',
    tx,
    dedupBidx,
  );
  delete values.id;
  delete values.accountId;
  const oldAmount = BigInt(decryptString(dk, row.amountEnc, aad('amount', row.id)));
  if (oldAmount !== tx.amount.minor || row.currency !== tx.amount.currency) {
    await db.delete(transactionSplits).where(eq(transactionSplits.transactionId, row.id));
  }
  await db
    .update(transactions)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(transactions.id, row.id));
}

async function updateIfChanged(
  db: DbOrTx,
  dk: DataKey,
  row: Row,
  tx: ProviderTransaction,
  dedupBidx: string,
): Promise<boolean> {
  // A booked row never goes back to pending (banks may keep reporting the pending twin for a while).
  if (row.status === 'booked' && tx.status === 'pending') return false;
  const amount = BigInt(decryptString(dk, row.amountEnc, aad('amount', row.id)));
  const counterparty = row.counterpartyEnc
    ? decryptString(dk, row.counterpartyEnc, aad('counterparty', row.id))
    : undefined;
  const purpose = row.purposeEnc
    ? decryptString(dk, row.purposeEnc, aad('purpose', row.id))
    : undefined;
  const counterpartyIban = row.counterpartyIbanEnc
    ? decryptString(dk, row.counterpartyIbanEnc, aad('counterparty_iban', row.id))
    : undefined;
  const same =
    row.status === tx.status &&
    row.bookingDate === tx.bookingDate &&
    (row.valueDate ?? undefined) === tx.valueDate &&
    amount === tx.amount.minor &&
    row.currency === tx.amount.currency &&
    counterparty === tx.counterparty &&
    counterpartyIban === tx.counterpartyIban &&
    purpose === tx.purpose &&
    (row.mcc ?? undefined) === tx.mcc;
  if (same) return false;
  await writeTx(db, dk, row, tx, dedupBidx);
  return true;
}

async function findPendingMatch(
  db: DbOrTx,
  dk: DataKey,
  accountId: string,
  tx: ProviderTransaction,
  reconciled: Set<string>,
): Promise<Row | null> {
  if (tx.counterparty === undefined) return null;
  const bidx = blindIndex(dk, 'tx-counterparty', normalizeCounterparty(tx.counterparty));
  const candidates = await db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.accountId, accountId),
        eq(transactions.status, 'pending'),
        eq(transactions.counterpartyBidx, bidx),
        eq(transactions.currency, tx.amount.currency),
      ),
    );
  const booked = dayNumber(tx.bookingDate);
  let best: { row: Row; diff: bigint; days: number } | null = null;
  for (const row of candidates) {
    if (reconciled.has(row.id)) continue;
    const days = booked - dayNumber(row.bookingDate);
    if (days < 0 || days > RECONCILE_WINDOW_DAYS) continue;
    const pending = BigInt(decryptString(dk, row.amountEnc, aad('amount', row.id)));
    if (pending === 0n || pending < 0n !== tx.amount.minor < 0n) continue;
    const abs = (n: bigint) => (n < 0n ? -n : n);
    const diff = abs(tx.amount.minor - pending);
    if (diff * 100n > abs(pending) * RECONCILE_AMOUNT_TOLERANCE_PERCENT) continue;
    if (!best || diff < best.diff || (diff === best.diff && days < best.days)) {
      best = { row, diff, days };
    }
  }
  return best?.row ?? null;
}

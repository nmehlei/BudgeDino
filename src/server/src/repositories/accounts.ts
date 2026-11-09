import { and, eq, inArray } from 'drizzle-orm';
import { blindIndex, decryptString, encryptField, type DataKey } from '../crypto/index.js';
import type { Db } from '../db/client.js';
import { newId } from '../db/ids.js';
import { accounts, connectors } from '../db/schema.js';
import type { VisibleAccountIds } from '../access/visibility.js';
import type { AuthContext } from '../deps.js';

const aad = (column: string, rowId: string) => ({ table: 'accounts', column, rowId });

type AccountKind = (typeof accounts.$inferInsert)['kind'];

export interface NewAccount {
  connectorId: string;
  ownerMemberId: string;
  /** Bank-side identifier; stored only as a blind index. */
  externalRef: string;
  name: string;
  iban?: string;
  kind: AccountKind;
  currency: string;
  visibility?: 'household' | 'owner_only';
  countsTowardBudgets?: boolean;
  balanceMinor?: bigint;
}

export interface Account {
  id: string;
  connectorId: string;
  ownerMemberId: string;
  name: string;
  iban: string | null;
  kind: AccountKind;
  currency: string;
  visibility: 'household' | 'owner_only';
  countsTowardBudgets: boolean;
  balanceMinor: bigint | null;
}

export async function createAccount(db: Db, dk: DataKey, input: NewAccount): Promise<string> {
  const id = newId();
  const visibility = input.visibility ?? 'household';
  await db.insert(accounts).values({
    id,
    connectorId: input.connectorId,
    ownerMemberId: input.ownerMemberId,
    externalRefBidx: blindIndex(dk, 'account-external-ref', input.externalRef),
    externalRefEnc: encryptField(dk, input.externalRef, aad('external_ref', id)),
    nameEnc: encryptField(dk, input.name, aad('name', id)),
    ibanEnc: input.iban === undefined ? null : encryptField(dk, input.iban, aad('iban', id)),
    kind: input.kind,
    currency: input.currency,
    visibility,
    countsTowardBudgets: input.countsTowardBudgets ?? visibility === 'household',
    balanceEnc:
      input.balanceMinor === undefined
        ? null
        : encryptField(dk, input.balanceMinor.toString(), aad('balance', id)),
    balanceAt: input.balanceMinor === undefined ? null : new Date(),
  });
  return id;
}

/** The bank-side reference of an account (needed to fetch); null for rows stored before it was kept. */
export function decryptExternalRef(
  dk: DataKey,
  row: Pick<typeof accounts.$inferSelect, 'id' | 'externalRefEnc'>,
): string | null {
  return row.externalRefEnc
    ? decryptString(dk, row.externalRefEnc, aad('external_ref', row.id))
    : null;
}

function toAccount(dk: DataKey, row: typeof accounts.$inferSelect): Account {
  return {
    id: row.id,
    connectorId: row.connectorId,
    ownerMemberId: row.ownerMemberId,
    name: decryptString(dk, row.nameEnc, aad('name', row.id)),
    iban: row.ibanEnc ? decryptString(dk, row.ibanEnc, aad('iban', row.id)) : null,
    kind: row.kind,
    currency: row.currency,
    visibility: row.visibility,
    countsTowardBudgets: row.countsTowardBudgets,
    balanceMinor: row.balanceEnc
      ? BigInt(decryptString(dk, row.balanceEnc, aad('balance', row.id)))
      : null,
  };
}

/** Reads one account; an account outside `visible` is indistinguishable from a missing one. */
export async function getAccount(
  db: Db,
  dk: DataKey,
  visible: VisibleAccountIds,
  id: string,
): Promise<Account> {
  if (!visible.includes(id)) throw new Error('Account not found');
  const [row] = await db.select().from(accounts).where(eq(accounts.id, id));
  if (!row) throw new Error('Account not found');
  return toAccount(dk, row);
}

export async function listAccounts(
  db: Db,
  dk: DataKey,
  visible: VisibleAccountIds,
): Promise<Account[]> {
  if (visible.length === 0) return [];
  const rows = await db
    .select()
    .from(accounts)
    .where(inArray(accounts.id, [...visible]));
  return rows.map((row) => toAccount(dk, row));
}

export interface AccountPatch {
  visibility?: 'household' | 'owner_only' | undefined;
  countsTowardBudgets?: boolean | undefined;
}

/**
 * Updates an account the caller owns (inside their household). Returns null when the account does
 * not exist or belongs to someone else, so callers answer both with the same 404.
 * Switching to `owner_only` also stops counting toward budgets unless `countsTowardBudgets` is given.
 */
export async function updateOwnAccount(
  db: Db,
  dk: DataKey,
  ctx: Pick<AuthContext, 'memberId' | 'householdId'>,
  id: string,
  patch: AccountPatch,
): Promise<Account | null> {
  const [owned] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .innerJoin(connectors, eq(accounts.connectorId, connectors.id))
    .where(
      and(
        eq(accounts.id, id),
        eq(accounts.ownerMemberId, ctx.memberId),
        eq(connectors.householdId, ctx.householdId),
      ),
    );
  if (!owned) return null;
  const counts =
    patch.countsTowardBudgets ?? (patch.visibility === 'owner_only' ? false : undefined);
  const [row] = await db
    .update(accounts)
    .set({
      ...(patch.visibility === undefined ? {} : { visibility: patch.visibility }),
      ...(counts === undefined ? {} : { countsTowardBudgets: counts }),
    })
    .where(and(eq(accounts.id, id), eq(accounts.ownerMemberId, ctx.memberId)))
    .returning();
  return row ? toAccount(dk, row) : null;
}

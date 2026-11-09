import { eq } from 'drizzle-orm';
import { blindIndex, decryptString, encryptField, type DataKey } from '../crypto/index.js';
import type { Db } from '../db/client.js';
import { newId } from '../db/ids.js';
import { accounts } from '../db/schema.js';

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

export async function getAccount(db: Db, dk: DataKey, id: string): Promise<Account> {
  const [row] = await db.select().from(accounts).where(eq(accounts.id, id));
  if (!row) throw new Error('Account not found');
  return {
    id: row.id,
    connectorId: row.connectorId,
    ownerMemberId: row.ownerMemberId,
    name: decryptString(dk, row.nameEnc, aad('name', id)),
    iban: row.ibanEnc ? decryptString(dk, row.ibanEnc, aad('iban', id)) : null,
    kind: row.kind,
    currency: row.currency,
    visibility: row.visibility,
    countsTowardBudgets: row.countsTowardBudgets,
    balanceMinor: row.balanceEnc
      ? BigInt(decryptString(dk, row.balanceEnc, aad('balance', id)))
      : null,
  };
}

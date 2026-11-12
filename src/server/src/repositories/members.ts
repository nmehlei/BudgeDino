import { eq } from 'drizzle-orm';
import {
  decryptString,
  encryptField,
  masterBlindIndex,
  type DataKey,
  type MasterKey,
} from '../crypto/index.js';
import type { Db, DbOrTx } from '../db/client.js';
import { newId } from '../db/ids.js';
import { members } from '../db/schema.js';

const aad = (column: string, rowId: string) => ({ table: 'members', column, rowId });

export interface NewMember {
  householdId: string;
  role: 'admin' | 'member';
  email: string;
  /** Server-wide email blind index, see `emailBlindIndex`. */
  emailBidx: string;
  displayName: string;
  passwordHash: string;
  /** Base32 TOTP secret (stored encrypted). */
  totpSecret?: string;
  /** TOTP time step already consumed (e.g. by the registration confirmation). */
  totpLastStep?: number;
}

export interface Member {
  id: string;
  householdId: string;
  role: 'admin' | 'member';
  email: string;
  displayName: string;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Login lookup key: HMAC under a master-key subkey over the normalised email (R5). */
export function emailBlindIndex(master: MasterKey, email: string): string {
  return masterBlindIndex(master, 'email', normalizeEmail(email));
}

export async function createMember(db: DbOrTx, dk: DataKey, input: NewMember): Promise<string> {
  const id = newId();
  await db.insert(members).values({
    id,
    householdId: input.householdId,
    role: input.role,
    emailBidx: input.emailBidx,
    emailEnc: encryptField(dk, input.email.trim(), aad('email', id)),
    displayNameEnc: encryptField(dk, input.displayName, aad('display_name', id)),
    passwordHash: input.passwordHash,
    totpSecretEnc: input.totpSecret
      ? encryptField(dk, input.totpSecret, aad('totp_secret', id))
      : null,
    totpLastStep: input.totpLastStep ?? null,
  });
  return id;
}

export function decryptTotpSecret(dk: DataKey, id: string, blob: Buffer): string {
  return decryptString(dk, blob, aad('totp_secret', id));
}

export function decryptMemberEmail(dk: DataKey, id: string, blob: Buffer): string {
  return decryptString(dk, blob, aad('email', id));
}

export function decryptMemberDisplayName(dk: DataKey, id: string, blob: Buffer): string {
  return decryptString(dk, blob, aad('display_name', id));
}

export async function getMember(db: Db, dk: DataKey, id: string): Promise<Member> {
  const [row] = await db.select().from(members).where(eq(members.id, id));
  if (!row) throw new Error('Member not found');
  return {
    id: row.id,
    householdId: row.householdId,
    role: row.role,
    email: decryptString(dk, row.emailEnc, aad('email', id)),
    displayName: decryptString(dk, row.displayNameEnc, aad('display_name', id)),
  };
}

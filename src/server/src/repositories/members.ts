import { eq } from 'drizzle-orm';
import { blindIndex, decryptString, encryptField, type DataKey } from '../crypto/index.js';
import type { Db } from '../db/client.js';
import { newId } from '../db/ids.js';
import { members } from '../db/schema.js';

const aad = (column: string, rowId: string) => ({ table: 'members', column, rowId });

export interface NewMember {
  householdId: string;
  role: 'admin' | 'member';
  email: string;
  displayName: string;
  passwordHash: string;
}

export interface Member {
  id: string;
  householdId: string;
  role: 'admin' | 'member';
  email: string;
  displayName: string;
}

export function emailBlindIndex(dk: DataKey, email: string): string {
  return blindIndex(dk, 'member-email', email.trim().toLowerCase());
}

export async function createMember(db: Db, dk: DataKey, input: NewMember): Promise<string> {
  const id = newId();
  await db.insert(members).values({
    id,
    householdId: input.householdId,
    role: input.role,
    emailBidx: emailBlindIndex(dk, input.email),
    emailEnc: encryptField(dk, input.email, aad('email', id)),
    displayNameEnc: encryptField(dk, input.displayName, aad('display_name', id)),
    passwordHash: input.passwordHash,
  });
  return id;
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

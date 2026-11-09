import { and, eq, gt, isNull } from 'drizzle-orm';
import { hashToken, newToken } from '../auth/tokens.js';
import type { DbOrTx } from '../db/client.js';
import { invites } from '../db/schema.js';

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface CreatedInvite {
  /** Shown once; only its hash is stored. */
  token: string;
  expiresAt: Date;
}

export async function createInvite(
  db: DbOrTx,
  input: { householdId: string; role: 'admin' | 'member'; now: Date },
): Promise<CreatedInvite> {
  const token = newToken();
  const expiresAt = new Date(input.now.getTime() + INVITE_TTL_MS);
  await db.insert(invites).values({
    householdId: input.householdId,
    tokenHash: hashToken(token),
    role: input.role,
    expiresAt,
  });
  return { token, expiresAt };
}

export interface InviteInfo {
  householdId: string;
  role: 'admin' | 'member';
}

/** Non-consuming check (exists, unused, unexpired). */
export async function findValidInvite(
  db: DbOrTx,
  tokenHash: string,
  now: Date,
): Promise<InviteInfo | null> {
  const [row] = await db
    .select({ householdId: invites.householdId, role: invites.role })
    .from(invites)
    .where(
      and(eq(invites.tokenHash, tokenHash), isNull(invites.usedAt), gt(invites.expiresAt, now)),
    );
  return row ?? null;
}

/**
 * Marks the invite used if (and only if) it is still valid. A single conditional UPDATE: of two
 * concurrent callers the second waits on the row lock, re-evaluates `used_at is null` and gets null.
 */
export async function consumeInvite(
  db: DbOrTx,
  tokenHash: string,
  now: Date,
): Promise<InviteInfo | null> {
  const [row] = await db
    .update(invites)
    .set({ usedAt: now })
    .where(
      and(eq(invites.tokenHash, tokenHash), isNull(invites.usedAt), gt(invites.expiresAt, now)),
    )
    .returning({ householdId: invites.householdId, role: invites.role });
  return row ?? null;
}

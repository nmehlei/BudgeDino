import { and, asc, eq, gt, isNull } from 'drizzle-orm';
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

export interface PendingInviteRow {
  id: string;
  role: 'admin' | 'member';
  expiresAt: Date;
}

/** Unused, unexpired invites of one household, soonest-expiring first. Never selects the token hash. */
export async function listPendingInvites(
  db: DbOrTx,
  householdId: string,
  now: Date,
): Promise<PendingInviteRow[]> {
  return db
    .select({ id: invites.id, role: invites.role, expiresAt: invites.expiresAt })
    .from(invites)
    .where(
      and(eq(invites.householdId, householdId), isNull(invites.usedAt), gt(invites.expiresAt, now)),
    )
    .orderBy(asc(invites.expiresAt), asc(invites.id));
}

export type RevokeInviteResult = 'revoked' | 'used' | 'not_found';

/**
 * Deletes a pending invite of the household. A single conditional DELETE (so it cannot race with
 * `consumeInvite`); when nothing was deleted a second lookup tells "already used" from "not found"
 * (unknown, expired or another household's).
 */
export async function revokeInvite(
  db: DbOrTx,
  householdId: string,
  id: string,
  now: Date,
): Promise<RevokeInviteResult> {
  const deleted = await db
    .delete(invites)
    .where(
      and(
        eq(invites.id, id),
        eq(invites.householdId, householdId),
        isNull(invites.usedAt),
        gt(invites.expiresAt, now),
      ),
    )
    .returning({ id: invites.id });
  if (deleted.length > 0) return 'revoked';
  const [row] = await db
    .select({ usedAt: invites.usedAt })
    .from(invites)
    .where(and(eq(invites.id, id), eq(invites.householdId, householdId)));
  return row?.usedAt ? 'used' : 'not_found';
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

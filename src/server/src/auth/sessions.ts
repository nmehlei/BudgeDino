import { and, desc, eq, isNull, lt, or } from 'drizzle-orm';
import { decryptString, encryptField } from '../crypto/index.js';
import type { Db, DbOrTx } from '../db/client.js';
import { newId } from '../db/ids.js';
import { members, sessions } from '../db/schema.js';
import type { AuthContext } from '../deps.js';
import type { Keyring } from '../households/keyring.js';
import { ABSOLUTE_SESSION_LIFETIME_MS, IDLE_SESSION_TIMEOUT_MS } from './session-policy.js';
import { hashToken, newToken } from './tokens.js';

const LAST_SEEN_GRANULARITY_MS = 60_000;
const aad = (rowId: string) => ({ table: 'sessions', column: 'device_name', rowId });

export interface CreatedSession {
  id: string;
  token: string;
}

export async function createSession(
  db: DbOrTx,
  keyring: Keyring,
  input: { memberId: string; householdId: string; deviceName: string; now: Date },
): Promise<CreatedSession> {
  const id = newId();
  const token = newToken();
  const dk = await keyring.forHousehold(input.householdId);
  await db.insert(sessions).values({
    id,
    memberId: input.memberId,
    deviceNameEnc: encryptField(dk, input.deviceName, aad(id)),
    tokenHash: hashToken(token),
    createdAt: input.now,
    lastSeenAt: input.now,
  });
  return { id, token };
}

/**
 * Resolves a bearer token to its auth context, or null for unknown, revoked or disabled-member
 * sessions. Bumps `last_seen_at` at most once per minute.
 */
export async function authenticateSession(
  db: Db,
  token: string,
  now: Date,
): Promise<AuthContext | null> {
  const [row] = await db
    .select({
      sessionId: sessions.id,
      memberId: sessions.memberId,
      revokedAt: sessions.revokedAt,
      lastSeenAt: sessions.lastSeenAt,
      createdAt: sessions.createdAt,
      householdId: members.householdId,
      role: members.role,
      disabledAt: members.disabledAt,
    })
    .from(sessions)
    .innerJoin(members, eq(sessions.memberId, members.id))
    .where(eq(sessions.tokenHash, hashToken(token)));
  if (!row || row.revokedAt || row.disabledAt) return null;
  // Expired sessions are indistinguishable from invalid tokens (same null -> same 401).
  const nowMs = now.getTime();
  if (nowMs - row.createdAt.getTime() > ABSOLUTE_SESSION_LIFETIME_MS) return null;
  if (nowMs - (row.lastSeenAt ?? row.createdAt).getTime() > IDLE_SESSION_TIMEOUT_MS) return null;

  const stale =
    !row.lastSeenAt || now.getTime() - row.lastSeenAt.getTime() >= LAST_SEEN_GRANULARITY_MS;
  if (stale) {
    const threshold = new Date(now.getTime() - LAST_SEEN_GRANULARITY_MS);
    await db
      .update(sessions)
      .set({ lastSeenAt: now })
      .where(
        and(
          eq(sessions.id, row.sessionId),
          or(isNull(sessions.lastSeenAt), lt(sessions.lastSeenAt, threshold)),
        ),
      );
  }
  return {
    memberId: row.memberId,
    householdId: row.householdId,
    role: row.role,
    sessionId: row.sessionId,
  };
}

export interface SessionSummary {
  id: string;
  deviceName: string | null;
  createdAt: Date;
  lastSeenAt: Date | null;
  current: boolean;
}

export async function listSessions(
  db: Db,
  keyring: Keyring,
  auth: AuthContext,
): Promise<SessionSummary[]> {
  const dk = await keyring.forHousehold(auth.householdId);
  const rows = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.memberId, auth.memberId), isNull(sessions.revokedAt)))
    .orderBy(desc(sessions.createdAt));
  return rows.map((row) => ({
    id: row.id,
    deviceName: row.deviceNameEnc ? decryptString(dk, row.deviceNameEnc, aad(row.id)) : null,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    current: row.id === auth.sessionId,
  }));
}

/** Revokes one of the caller's own sessions. Returns false when there is no such active session. */
export async function revokeSession(
  db: Db,
  auth: AuthContext,
  sessionId: string,
  now: Date,
): Promise<boolean> {
  const updated = await db
    .update(sessions)
    .set({ revokedAt: now })
    .where(
      and(
        eq(sessions.id, sessionId),
        eq(sessions.memberId, auth.memberId),
        isNull(sessions.revokedAt),
      ),
    )
    .returning({ id: sessions.id });
  return updated.length > 0;
}

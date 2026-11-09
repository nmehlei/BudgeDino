import { randomBytes } from 'node:crypto';
import { createSession } from '@budgedino/server/auth/sessions';
import { loadMasterKey, type MasterKey } from '@budgedino/server/crypto';
import type { Db } from '@budgedino/server/db/client';
import { newId } from '@budgedino/server/db/ids';
import { challenges, connectors, households } from '@budgedino/server/db/schema';
import { Keyring } from '@budgedino/server/households/keyring';
import { createMember } from '@budgedino/server/repositories/members';

export function randomMasterKey(): MasterKey {
  return loadMasterKey({ BUDGEDINO_MASTER_KEY: randomBytes(32).toString('base64') });
}

/** Creates a household together with its active data key. */
export async function createHousehold(db: Db, keyring: Keyring, name = 'Test household') {
  const id = newId();
  await db.insert(households).values({ id, name });
  await keyring.createForHousehold(id);
  return id;
}

let counter = 0;

export async function createTestMember(
  db: Db,
  keyring: Keyring,
  householdId: string,
  overrides: { email?: string; displayName?: string; role?: 'admin' | 'member' } = {},
) {
  counter += 1;
  const email = overrides.email ?? `member${counter}@example.test`;
  return createMember(db, await keyring.forHousehold(householdId), {
    householdId,
    role: overrides.role ?? 'admin',
    email,
    emailBidx: keyring.emailIndex(email),
    displayName: overrides.displayName ?? `Member ${counter}`,
    passwordHash: 'argon2id$test',
  });
}

/** Creates a session for a member and returns its bearer token. */
export async function createTestSession(
  db: Db,
  keyring: Keyring,
  householdId: string,
  memberId: string,
  now: Date = new Date(),
): Promise<string> {
  const session = await createSession(db, keyring, {
    memberId,
    householdId,
    deviceName: 'Test device',
    now,
  });
  return session.token;
}

export async function createTestConnector(
  db: Db,
  keyring: Keyring,
  householdId: string,
  ownerMemberId: string,
) {
  const { encryptField } = await import('@budgedino/server/crypto');
  const id = newId();
  const dk = await keyring.forHousehold(householdId);
  await db.insert(connectors).values({
    id,
    householdId,
    ownerMemberId,
    type: 'fake',
    configEnc: encryptField(dk, '{}', { table: 'connectors', column: 'config', rowId: id }),
  });
  return id;
}

/** An open `code` challenge (10 min TTL from now) on the connector, with an encrypted envelope. */
export async function createTestChallenge(
  db: Db,
  keyring: Keyring,
  householdId: string,
  connectorId: string,
  memberId: string,
) {
  const { sealEnvelope } = await import('@budgedino/server/connectors/challenge-service');
  const id = newId();
  const dk = await keyring.forHousehold(householdId);
  await db.insert(challenges).values({
    id,
    connectorId,
    memberId,
    kind: 'code',
    payloadEnc: sealEnvelope(dk, id, {
      challenge: { kind: 'code', message: 'Enter the TAN' },
      dialog: {},
      invalidAnswers: 0,
      lastPollAt: null,
    }),
    status: 'open',
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });
  return id;
}

import { randomBytes } from 'node:crypto';
import { loadMasterKey, type MasterKey } from '@budgedino/server/crypto';
import type { Db } from '@budgedino/server/db/client';
import { newId } from '@budgedino/server/db/ids';
import { connectors, households } from '@budgedino/server/db/schema';
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
  return createMember(db, await keyring.forHousehold(householdId), {
    householdId,
    role: overrides.role ?? 'admin',
    email: overrides.email ?? `member${counter}@example.test`,
    displayName: overrides.displayName ?? `Member ${counter}`,
    passwordHash: 'argon2id$test',
  });
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

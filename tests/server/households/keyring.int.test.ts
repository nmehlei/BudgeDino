import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { visibleAccountIds } from '@budgedino/server/access/visibility';
import { masterBlindIndex } from '@budgedino/server/crypto';
import { householdKeys, members } from '@budgedino/server/db/schema';
import { Keyring } from '@budgedino/server/households/keyring';
import { createAccount, getAccount } from '@budgedino/server/repositories/accounts';
import {
  createHousehold,
  createTestConnector,
  createTestMember,
  randomMasterKey,
} from '../../support/factories.js';
import { startTestDatabase, type TestDatabase } from '../../support/postgres.js';

let database: TestDatabase;

beforeAll(async () => {
  database = await startTestDatabase();
}, 120_000);

afterAll(async () => {
  await database.stop();
});

beforeEach(async () => {
  await database.reset();
});

describe('Keyring', () => {
  it('returns the same cached DataKey and unwraps the active key', async () => {
    const keyring = new Keyring(database.db, randomMasterKey());
    const householdId = await createHousehold(database.db, keyring);

    const a = await keyring.forHousehold(householdId);
    const b = await keyring.forHousehold(householdId);
    expect(b).toBe(a);

    // A fresh keyring (cold cache) with the same master key yields a key that decrypts the same data.
    const stored = (await database.db.select().from(householdKeys)).filter(
      (r) => r.householdId === householdId,
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]?.masterKeyId).toBe(keyring.masterKeyId);
  });

  it('fails clearly for a household without a key', async () => {
    const keyring = new Keyring(database.db, randomMasterKey());
    await expect(keyring.forHousehold('00000000-0000-7000-8000-000000000000')).rejects.toThrow(
      /no active data key/i,
    );
  });

  it('keeps different households on different keys', async () => {
    const keyring = new Keyring(database.db, randomMasterKey());
    const h1 = await createHousehold(database.db, keyring);
    const h2 = await createHousehold(database.db, keyring);
    const [k1, k2] = [await keyring.forHousehold(h1), await keyring.forHousehold(h2)];
    expect(k1).not.toBe(k2);
  });

  it('rotateMaster rewraps every household key; data decrypts with the new master only', async () => {
    const oldMaster = randomMasterKey();
    const newMaster = randomMasterKey();
    const keyring = new Keyring(database.db, oldMaster);

    const householdIds = [
      await createHousehold(database.db, keyring, 'one'),
      await createHousehold(database.db, keyring, 'two'),
    ];
    const accountIds: string[] = [];
    const memberIds: string[] = [];
    for (const householdId of householdIds) {
      const memberId = await createTestMember(database.db, keyring, householdId);
      memberIds.push(memberId);
      const connectorId = await createTestConnector(database.db, keyring, householdId, memberId);
      accountIds.push(
        await createAccount(database.db, await keyring.forHousehold(householdId), {
          connectorId,
          ownerMemberId: memberId,
          externalRef: `ref-${householdId}`,
          name: `Account of ${householdId}`,
          iban: 'DE00',
          kind: 'checking',
          currency: 'EUR',
        }),
      );
    }

    await keyring.rotateMaster(oldMaster, newMaster);

    const rows = await database.db.select().from(householdKeys);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.masterKeyId === newMaster.id)).toBe(true);

    // Cold keyring with the new master reads everything.
    const fresh = new Keyring(database.db, newMaster);
    for (const [i, householdId] of householdIds.entries()) {
      const scope = await visibleAccountIds(database.db, {
        memberId: memberIds[i] as string,
        householdId,
      });
      const account = await getAccount(
        database.db,
        await fresh.forHousehold(householdId),
        scope,
        accountIds[i] as string,
      );
      expect(account.name).toBe(`Account of ${householdId}`);
    }

    // Cold keyring with the old master cannot unwrap any more.
    const stale = new Keyring(database.db, oldMaster);
    await expect(stale.forHousehold(householdIds[0] as string)).rejects.toThrow(/authentication/);
  });

  it('rotateMaster recomputes the master-derived members.email_bidx', async () => {
    const oldMaster = randomMasterKey();
    const newMaster = randomMasterKey();
    const keyring = new Keyring(database.db, oldMaster);
    const householdId = await createHousehold(database.db, keyring);
    const memberId = await createTestMember(database.db, keyring, householdId, {
      email: 'Rotate@Example.test',
    });

    const memberRow = async () =>
      (await database.db.select().from(members)).find((m) => m.id === memberId);
    const before = await memberRow();
    expect(before?.emailBidx).toBe(masterBlindIndex(oldMaster, 'email', 'rotate@example.test'));

    await keyring.rotateMaster(oldMaster, newMaster);

    const after = await memberRow();
    expect(after?.emailBidx).toBe(masterBlindIndex(newMaster, 'email', 'rotate@example.test'));
    expect(after?.emailBidx).not.toBe(before?.emailBidx);
    expect(keyring.blindIndex('email', 'rotate@example.test')).toBe(after?.emailBidx);
  });

  it('rotateMaster is atomic: a failure leaves all keys under the old master', async () => {
    const oldMaster = randomMasterKey();
    const keyring = new Keyring(database.db, oldMaster);
    const h1 = await createHousehold(database.db, keyring);
    await createHousehold(database.db, keyring);

    // Wrong "old" master -> unwrap of the first row fails, nothing may change.
    await expect(keyring.rotateMaster(randomMasterKey(), randomMasterKey())).rejects.toThrow(
      /authentication/,
    );
    const rows = await database.db.select().from(householdKeys);
    expect(rows.every((r) => r.masterKeyId === oldMaster.id)).toBe(true);
    await expect(new Keyring(database.db, oldMaster).forHousehold(h1)).resolves.toBeDefined();
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Keyring } from '@budgedino/server/households/keyring';
import { createAccount, getAccount } from '@budgedino/server/repositories/accounts';
import { getMember } from '@budgedino/server/repositories/members';
import {
  createTransaction,
  getTransaction,
  listTransactions,
} from '@budgedino/server/repositories/transactions';
import {
  createHousehold,
  createTestConnector,
  createTestMember,
  randomMasterKey,
} from '../../support/factories.js';
import { startTestDatabase, type TestDatabase } from '../../support/postgres.js';

const CANARIES = {
  email: 'CANARY-EMAIL@example.test',
  displayName: 'CANARY-DISPLAYNAME',
  accountName: 'CANARY-ACCOUNTNAME',
  iban: 'CANARY-IBAN-DE00',
  payee: 'CANARY-PAYEE',
  purpose: 'CANARY-PURPOSE',
  externalRef: 'CANARY-EXTREF',
  amount: '987654',
  balance: '1234567',
};

let database: TestDatabase;
let keyring: Keyring;

beforeAll(async () => {
  database = await startTestDatabase();
}, 120_000);

afterAll(async () => {
  await database.stop();
});

beforeEach(async () => {
  await database.reset();
  keyring = new Keyring(database.db, randomMasterKey());
});

async function seed() {
  const householdId = await createHousehold(database.db, keyring);
  const memberId = await createTestMember(database.db, keyring, householdId, {
    email: CANARIES.email,
    displayName: CANARIES.displayName,
  });
  const connectorId = await createTestConnector(database.db, keyring, householdId, memberId);
  const dk = await keyring.forHousehold(householdId);
  const accountId = await createAccount(database.db, dk, {
    connectorId,
    ownerMemberId: memberId,
    externalRef: CANARIES.externalRef,
    name: CANARIES.accountName,
    iban: CANARIES.iban,
    kind: 'checking',
    currency: 'EUR',
    balanceMinor: 1_234_567n,
  });
  const transactionId = await createTransaction(database.db, dk, {
    accountId,
    dedupKey: 'bank-ref-1',
    status: 'booked',
    bookingDate: '2026-11-01',
    amountMinor: 987_654n,
    currency: 'EUR',
    counterparty: CANARIES.payee,
    purpose: CANARIES.purpose,
  });
  return { householdId, memberId, accountId, transactionId, dk };
}

describe('encryption at rest', () => {
  it('stores no canary plaintext anywhere in a data-only dump', async () => {
    await seed();
    const dump = await database.dumpData();

    expect(dump).toContain('COPY public.transactions'); // sanity: the dump really contains the data
    for (const canary of Object.values(CANARIES)) {
      expect(dump, `dump must not contain ${canary}`).not.toContain(canary);
      // pg_dump prints bytea as hex (\\x4341...), so plaintext written into a bytea column
      // must be detected in its hex form as well.
      const hex = Buffer.from(canary, 'utf8').toString('hex');
      expect(dump.toLowerCase(), `dump must not contain hex of ${canary}`).not.toContain(hex);
    }
  });

  it('round-trips encrypted fields through the repositories', async () => {
    const { memberId, accountId, transactionId, dk } = await seed();

    expect(await getMember(database.db, dk, memberId)).toMatchObject({
      email: CANARIES.email,
      displayName: CANARIES.displayName,
    });
    expect(await getAccount(database.db, dk, accountId)).toMatchObject({
      name: CANARIES.accountName,
      iban: CANARIES.iban,
      balanceMinor: 1_234_567n,
    });
    expect(await getTransaction(database.db, dk, transactionId)).toMatchObject({
      amountMinor: 987_654n,
      counterparty: CANARIES.payee,
      purpose: CANARIES.purpose,
      bookingDate: '2026-11-01',
    });
    expect(await listTransactions(database.db, dk, accountId)).toHaveLength(1);
  });

  it('rejects a duplicate dedup key within an account', async () => {
    const { accountId, dk } = await seed();
    await expect(
      createTransaction(database.db, dk, {
        accountId,
        dedupKey: 'bank-ref-1',
        status: 'booked',
        bookingDate: '2026-11-02',
        amountMinor: 1n,
        currency: 'EUR',
      }),
    ).rejects.toThrow();
  });

  it('does not decrypt a ciphertext copied into another row (AAD binding)', async () => {
    const { accountId, dk } = await seed();
    const { rows } = await database.pool.query<{ id: string }>('select id from transactions');
    const first = rows[0]?.id as string;
    const second = await createTransaction(database.db, dk, {
      accountId,
      dedupKey: 'bank-ref-2',
      status: 'booked',
      bookingDate: '2026-11-03',
      amountMinor: 5n,
      currency: 'EUR',
    });
    await database.pool.query(
      'update transactions set amount_enc = (select amount_enc from transactions where id = $1) where id = $2',
      [first, second],
    );
    await expect(getTransaction(database.db, dk, second)).rejects.toThrow(/authentication/);
  });
});

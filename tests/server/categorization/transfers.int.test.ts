import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CATEGORIES } from '@budgedino/server/categorization/defaults';
import { detectTransfers } from '@budgedino/server/categorization/transfers';
import type { DataKey } from '@budgedino/server/crypto';
import { categories, transactions } from '@budgedino/server/db/schema';
import { Keyring } from '@budgedino/server/households/keyring';
import { createAccount } from '@budgedino/server/repositories/accounts';
import { createTransaction } from '@budgedino/server/repositories/transactions';
import {
  createHousehold,
  createTestConnector,
  createTestMember,
  randomMasterKey,
} from '../../support/factories.js';
import { startTestDatabase, type TestDatabase } from '../../support/postgres.js';

let database: TestDatabase;
let keyring: Keyring;
let householdId: string;
let dk: DataKey;
let aAccount: string;
let bAccount: string;
let bHiddenAccount: string;
let transferCategoryId: string;
let counter = 0;

const IBAN_A = 'DE02120300000000202051';
const IBAN_B = 'DE89370400440532013000';

beforeAll(async () => {
  database = await startTestDatabase();
}, 120_000);
afterAll(async () => database.stop());

beforeEach(async () => {
  await database.reset();
  keyring = new Keyring(database.db, randomMasterKey());
  householdId = await createHousehold(database.db, keyring);
  dk = await keyring.forHousehold(householdId);
  await database.db.insert(categories).values(
    DEFAULT_CATEGORIES.map((c) => ({
      householdId,
      name: c.name,
      isIncome: c.isIncome ?? false,
      isTransfer: c.isTransfer ?? false,
    })),
  );
  const [transfer] = await database.db
    .select()
    .from(categories)
    .where(eq(categories.isTransfer, true));
  transferCategoryId = (transfer as { id: string }).id;
  const a = await createTestMember(database.db, keyring, householdId, { role: 'admin' });
  const b = await createTestMember(database.db, keyring, householdId, { role: 'member' });
  const ca = await createTestConnector(database.db, keyring, householdId, a);
  const cb = await createTestConnector(database.db, keyring, householdId, b);
  const mk = (connectorId: string, owner: string, ref: string, iban: string, visible = true) =>
    createAccount(database.db, dk, {
      connectorId,
      ownerMemberId: owner,
      externalRef: ref,
      name: ref,
      iban,
      kind: 'checking',
      currency: 'EUR',
      visibility: visible ? 'household' : 'owner_only',
    });
  aAccount = await mk(ca, a, 'a', IBAN_A);
  bAccount = await mk(cb, b, 'b', IBAN_B);
  bHiddenAccount = await mk(cb, b, 'b-hidden', 'DE44500105175407324931', false);
});

async function add(
  accountId: string,
  amountMinor: bigint,
  bookingDate: string,
  extra: { counterpartyIban?: string; counterparty?: string; currency?: string } = {},
) {
  counter += 1;
  return createTransaction(database.db, dk, {
    accountId,
    dedupKey: `t${counter}`,
    status: 'booked',
    bookingDate,
    amountMinor,
    currency: extra.currency ?? 'EUR',
    ...(extra.counterparty === undefined ? {} : { counterparty: extra.counterparty }),
    ...(extra.counterpartyIban === undefined ? {} : { counterpartyIban: extra.counterpartyIban }),
  });
}

async function row(id: string) {
  const [r] = await database.db.select().from(transactions).where(eq(transactions.id, id));
  return r as typeof transactions.$inferSelect;
}

const detect = (ids: string[]) => detectTransfers(database.db, keyring, householdId, ids);

describe('detectTransfers', () => {
  it('pairs opposite amounts across two members accounts and categorizes them as Transfer', async () => {
    const out = await add(aAccount, -50_000n, '2026-11-02');
    const inn = await add(bAccount, 50_000n, '2026-11-03');
    await detect([out]);
    const [o, i] = [await row(out), await row(inn)];
    expect(o.transferGroupId).not.toBeNull();
    expect(o.transferGroupId).toBe(i.transferGroupId);
    expect(o.categoryId).toBe(transferCategoryId);
    expect(i.categoryId).toBe(transferCategoryId);
    expect(o.categorySource).toBe('rule');
  });

  it('leaves a single unmatched outgoing transfer alone', async () => {
    const out = await add(aAccount, -50_000n, '2026-11-02');
    await add(bAccount, 50_001n, '2026-11-02');
    await add(bAccount, 50_000n, '2026-11-20');
    await detect([out]);
    expect((await row(out)).transferGroupId).toBeNull();
  });

  it('requires different accounts, same currency and a window of at most 4 days', async () => {
    const out = await add(aAccount, -1_000n, '2026-11-02');
    const sameAccount = await add(aAccount, 1_000n, '2026-11-02');
    const otherCurrency = await add(bAccount, 1_000n, '2026-11-02', { currency: 'USD' });
    const tooLate = await add(bAccount, 1_000n, '2026-11-07');
    await detect([out]);
    for (const id of [out, sameAccount, otherCurrency, tooLate]) {
      expect((await row(id)).transferGroupId).toBeNull();
    }
    const edge = await add(bAccount, 1_000n, '2026-11-06');
    await detect([out]);
    expect((await row(edge)).transferGroupId).not.toBeNull();
  });

  it('prefers the candidate whose counterparty IBAN is the other account, then the smaller gap', async () => {
    const out = await add(aAccount, -2_000n, '2026-11-05', { counterpartyIban: IBAN_B });
    const near = await add(bHiddenAccount, 2_000n, '2026-11-05');
    const ibanMatch = await add(bAccount, 2_000n, '2026-11-08');
    await detect([out]);
    expect((await row(out)).transferGroupId).toBe((await row(ibanMatch)).transferGroupId);
    expect((await row(near)).transferGroupId).toBeNull();

    const out2 = await add(aAccount, -3_000n, '2026-11-05');
    const far = await add(bAccount, 3_000n, '2026-11-08');
    const close = await add(bHiddenAccount, 3_000n, '2026-11-06');
    await detect([out2]);
    expect((await row(out2)).transferGroupId).toBe((await row(close)).transferGroupId);
    expect((await row(far)).transferGroupId).toBeNull();
  });

  it('puts each transaction in at most one pair', async () => {
    const o1 = await add(aAccount, -4_000n, '2026-11-05');
    const o2 = await add(aAccount, -4_000n, '2026-11-05');
    const i1 = await add(bAccount, 4_000n, '2026-11-05');
    await detect([o1, o2]);
    const rows = [await row(o1), await row(o2)];
    const paired = rows.filter((r) => r.transferGroupId !== null);
    expect(paired).toHaveLength(1);
    expect(paired[0]?.transferGroupId).toBe((await row(i1)).transferGroupId);
  });

  it('pairs into an owner_only account of another member (excluded from spending, not exposed)', async () => {
    const out = await add(aAccount, -7_000n, '2026-11-05');
    const hidden = await add(bHiddenAccount, 7_000n, '2026-11-05');
    await detect([out]);
    expect((await row(out)).categoryId).toBe(transferCategoryId);
    expect((await row(hidden)).transferGroupId).toBe((await row(out)).transferGroupId);
  });

  it('keeps a manual category but still groups the pair', async () => {
    const out = await add(aAccount, -9_000n, '2026-11-05');
    const inn = await add(bAccount, 9_000n, '2026-11-05');
    const [gifts] = await database.db
      .select()
      .from(categories)
      .where(eq(categories.name, 'Gifts & Donations'));
    await database.db
      .update(transactions)
      .set({ categoryId: (gifts as { id: string }).id, categorySource: 'manual' })
      .where(eq(transactions.id, out));
    await detect([out]);
    const [o, i] = [await row(out), await row(inn)];
    expect(o.categorySource).toBe('manual');
    expect(o.categoryId).toBe((gifts as { id: string }).id);
    expect(o.transferGroupId).toBe(i.transferGroupId);
    expect(i.categoryId).toBe(transferCategoryId);
  });
});

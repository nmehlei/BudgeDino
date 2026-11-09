import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '@budgedino/server/app';
import { createFakeConnector } from '@budgedino/server/connectors/fake/fake-connector';
import { createConnectorRegistry } from '@budgedino/server/connectors/registry';
import { DEFAULT_CATEGORIES } from '@budgedino/server/categorization/defaults';
import type { DataKey } from '@budgedino/server/crypto';
import { categories, connectors, rules, transactions } from '@budgedino/server/db/schema';
import { Keyring } from '@budgedino/server/households/keyring';
import { createLogger } from '@budgedino/server/observability/logger';
import { createAccount } from '@budgedino/server/repositories/accounts';
import { createTransaction } from '@budgedino/server/repositories/transactions';
import {
  createHousehold,
  createTestConnector,
  createTestMember,
  createTestSession,
  randomMasterKey,
} from '../../support/factories.js';
import { seedFakeConnector } from '../../support/sync.js';
import { startTestDatabase, type TestDatabase } from '../../support/postgres.js';

let database: TestDatabase;
let keyring: Keyring;
let app: FastifyInstance;
let householdId: string;
let dk: DataKey;
let aToken: string;
let bToken: string;
let aAccount: string;
let bHidden: string;
let cat: Record<string, string>;
let counter = 0;

beforeAll(async () => {
  database = await startTestDatabase();
}, 120_000);
afterAll(async () => {
  await app?.close();
  await database.stop();
});

beforeEach(async () => {
  await app?.close();
  await database.reset();
  const master = randomMasterKey();
  keyring = new Keyring(database.db, master);
  app = buildApp({
    db: database.db,
    keyring,
    master,
    registry: createConnectorRegistry([createFakeConnector()]),
    logger: createLogger({ level: 'silent' }),
  });
  await app.ready();
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
  cat = Object.fromEntries(
    (await database.db.select().from(categories)).map((c) => [c.name, c.id]),
  );
  const a = await createTestMember(database.db, keyring, householdId, { role: 'admin' });
  const b = await createTestMember(database.db, keyring, householdId, { role: 'member' });
  aToken = await createTestSession(database.db, keyring, householdId, a);
  bToken = await createTestSession(database.db, keyring, householdId, b);
  const ca = await createTestConnector(database.db, keyring, householdId, a);
  const cb = await createTestConnector(database.db, keyring, householdId, b);
  aAccount = await createAccount(database.db, dk, {
    connectorId: ca,
    ownerMemberId: a,
    externalRef: 'a',
    name: 'A',
    kind: 'checking',
    currency: 'EUR',
  });
  bHidden = await createAccount(database.db, dk, {
    connectorId: cb,
    ownerMemberId: b,
    externalRef: 'b',
    name: 'B',
    kind: 'checking',
    currency: 'EUR',
    visibility: 'owner_only',
  });
});

async function add(
  accountId: string,
  amountMinor: bigint,
  counterparty: string,
  extra: { counterpartyIban?: string; bookingDate?: string } = {},
) {
  counter += 1;
  return createTransaction(database.db, dk, {
    accountId,
    dedupKey: `r${counter}`,
    status: 'booked',
    bookingDate: extra.bookingDate ?? '2026-11-05',
    amountMinor,
    currency: 'EUR',
    counterparty,
    ...(extra.counterpartyIban === undefined ? {} : { counterpartyIban: extra.counterpartyIban }),
  });
}

async function call(
  method: 'GET' | 'PATCH' | 'POST',
  url: string,
  token: string,
  payload?: object,
) {
  const res = await app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload }),
  });
  return {
    status: res.statusCode,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed response bodies in tests
    json: JSON.parse(res.body || 'null') as Record<string, any>,
  };
}

async function row(id: string) {
  const [r] = await database.db.select().from(transactions).where(eq(transactions.id, id));
  return r as typeof transactions.$inferSelect;
}

describe('PATCH /transactions/:id', () => {
  it('sets a manual category and teaches future ingests via learned matches', async () => {
    const id = await add(aAccount, -500n, 'Bäckerei Müller');
    const res = await call('PATCH', `/transactions/${id}`, aToken, {
      categoryId: cat['Eating out'],
    });
    expect(res.status).toBe(200);
    expect(res.json['transaction']).toMatchObject({
      categoryId: cat['Eating out'],
      categorySource: 'manual',
    });
    expect(res.json['recategorized']).toBe(0);

    const next = await add(aAccount, -300n, 'Bäckerei Müller');
    const { categorizeTransactions } = await import('@budgedino/server/categorization/rules');
    await categorizeTransactions(database.db, keyring, householdId, [next]);
    expect(await row(next)).toMatchObject({
      categoryId: cat['Eating out'],
      categorySource: 'learned',
    });
  });

  it('applyToCounterparty creates a rule, recategorizes history household-wide and counts only visible rows', async () => {
    const { categorizeTransactions } = await import('@budgedino/server/categorization/rules');
    const visibleOld = await add(aAccount, -1_000n, 'Kiosk Eck', { bookingDate: '2026-10-01' });
    const hiddenOld = await add(bHidden, -2_000n, 'Kiosk Eck');
    const manualOld = await add(aAccount, -3_000n, 'Kiosk Eck');
    await database.db
      .update(transactions)
      .set({ categoryId: cat['Fees'] as string, categorySource: 'manual' })
      .where(eq(transactions.id, manualOld));
    const target = await add(aAccount, -4_000n, 'Kiosk Eck');

    const res = await call('PATCH', `/transactions/${target}`, aToken, {
      categoryId: cat['Leisure'],
      applyToCounterparty: true,
    });
    expect(res.status).toBe(200);
    expect(res.json['recategorized']).toBe(1); // visibleOld only; hidden counterpart not counted
    expect(await row(visibleOld)).toMatchObject({
      categoryId: cat['Leisure'],
      categorySource: 'rule',
    });
    expect(await row(hiddenOld)).toMatchObject({
      categoryId: cat['Leisure'],
      categorySource: 'rule',
    });
    expect((await row(manualOld)).categoryId).toBe(cat['Fees']);

    const [created] = await database.db.select().from(rules);
    expect(created?.priority).toBe(1);

    const future = await add(aAccount, -100n, 'KIOSK ECK');
    await categorizeTransactions(database.db, keyring, householdId, [future]);
    expect(await row(future)).toMatchObject({ categoryId: cat['Leisure'], categorySource: 'rule' });

    // a second rule gets a higher priority
    const other = await add(aAccount, -100n, 'Other Shop');
    await call('PATCH', `/transactions/${other}`, aToken, {
      categoryId: cat['Gifts & Donations'],
      applyToCounterparty: true,
    });
    const all = await database.db.select().from(rules);
    expect(all.map((r) => r.priority).sort()).toEqual([1, 2]);
  });

  it('uses the IBAN for the rule when the transaction has one', async () => {
    const { decryptString } = await import('@budgedino/server/crypto');
    const id = await add(aAccount, -4_000n, 'Stadtwerke', {
      counterpartyIban: 'DE02120300000000202051',
    });
    await call('PATCH', `/transactions/${id}`, aToken, {
      categoryId: cat['Utilities'],
      applyToCounterparty: true,
    });
    const [r] = await database.db.select().from(rules);
    const match = JSON.parse(
      decryptString(dk, (r as typeof rules.$inferSelect).matchEnc, {
        table: 'rules',
        column: 'match',
        rowId: (r as typeof rules.$inferSelect).id,
      }),
    ) as Record<string, string>;
    expect(match).toEqual({ counterpartyIban: 'DE02120300000000202051' });
  });

  it('returns 404 for a transaction the caller cannot see and 422 for a foreign category', async () => {
    const hidden = await add(bHidden, -1_000n, 'Secret');
    const res = await call('PATCH', `/transactions/${hidden}`, aToken, { categoryId: cat['Fees'] });
    expect(res.status).toBe(404);
    expect((await row(hidden)).categorySource).toBe('none');
    expect(
      (await call('PATCH', `/transactions/${hidden}`, bToken, { categoryId: cat['Fees'] })).status,
    ).toBe(200);

    const mine = await add(aAccount, -1_000n, 'Mine');
    const bad = await call('PATCH', `/transactions/${mine}`, aToken, {
      categoryId: '0198f0f0-0000-7000-8000-000000000000',
    });
    expect(bad.status).toBe(422);
  });
});

describe('POST /transactions/:id/splits', () => {
  it('stores splits that sum to the amount and replaces earlier ones', async () => {
    const id = await add(aAccount, -10_000n, 'Supermarkt');
    const body = (a: string, b: string) => ({
      parts: [
        { categoryId: cat['Groceries'], amount: { minor: a, currency: 'EUR' } },
        { categoryId: cat['Kids'], amount: { minor: b, currency: 'EUR' } },
      ],
    });
    const first = await call('POST', `/transactions/${id}/splits`, aToken, body('-6000', '-4000'));
    expect(first.status).toBe(200);
    expect(first.json['transaction'].splits).toHaveLength(2);
    const second = await call('POST', `/transactions/${id}/splits`, aToken, body('-9000', '-1000'));
    expect(
      second.json['transaction'].splits.map((s: { amountMinor: string }) => s.amountMinor).sort(),
    ).toEqual(['-1000', '-9000']);
    const list = await call('GET', '/transactions', aToken);
    expect(list.json['transactions'][0].splits).toHaveLength(2);
  });

  it('rejects mismatching sums, signs, currencies and unknown categories with 422; hidden tx is 404', async () => {
    const id = await add(aAccount, -10_000n, 'Supermarkt');
    const part = (minor: string, currency = 'EUR') => ({
      categoryId: cat['Groceries'],
      amount: { minor, currency },
    });
    for (const parts of [
      [part('-6000'), part('-3000')],
      [part('-12000'), part('2000')],
      [part('-5000'), part('-5000', 'USD')],
      [part('-10000'), part('0')],
    ]) {
      expect((await call('POST', `/transactions/${id}/splits`, aToken, { parts })).status).toBe(
        422,
      );
    }
    expect(
      (
        await call('POST', `/transactions/${id}/splits`, aToken, {
          parts: [
            {
              categoryId: '0198f0f0-0000-7000-8000-000000000000',
              amount: { minor: '-10000', currency: 'EUR' },
            },
          ],
        })
      ).status,
    ).toBe(422);
    const hidden = await add(bHidden, -100n, 'Secret');
    expect(
      (await call('POST', `/transactions/${hidden}/splits`, aToken, { parts: [part('-100')] }))
        .status,
    ).toBe(404);
  });
});

describe('GET /transactions', () => {
  it('lists only visible transactions, filters, and paginates with a cursor', async () => {
    await add(bHidden, -100n, 'HIDDEN-PAYEE');
    const ids: string[] = [];
    for (let day = 1; day <= 5; day++) {
      ids.push(
        await add(aAccount, -BigInt(day) * 100n, `Shop ${day}`, { bookingDate: `2026-11-0${day}` }),
      );
    }
    const page1 = await call('GET', '/transactions?limit=2', aToken);
    expect(page1.status).toBe(200);
    expect(JSON.stringify(page1.json)).not.toContain('HIDDEN-PAYEE');
    expect(page1.json['transactions'].map((t: { id: string }) => t.id)).toEqual([ids[4], ids[3]]);
    const page2 = await call(
      'GET',
      `/transactions?limit=2&cursor=${encodeURIComponent(page1.json['nextCursor'])}`,
      aToken,
    );
    expect(page2.json['transactions'].map((t: { id: string }) => t.id)).toEqual([ids[2], ids[1]]);
    const page3 = await call(
      'GET',
      `/transactions?limit=2&cursor=${encodeURIComponent(page2.json['nextCursor'])}`,
      aToken,
    );
    expect(page3.json['transactions']).toHaveLength(1);
    expect(page3.json['nextCursor']).toBeNull();

    const ranged = await call('GET', '/transactions?from=2026-11-02&to=2026-11-03', aToken);
    expect(ranged.json['transactions']).toHaveLength(2);
    const byAccount = await call('GET', `/transactions?accountId=${bHidden}`, aToken);
    expect(byAccount.json['transactions']).toEqual([]);
    const owner = await call('GET', `/transactions?accountId=${bHidden}`, bToken);
    expect(owner.json['transactions']).toHaveLength(1);
    expect(owner.json['transactions'][0].counterparty).toBe('HIDDEN-PAYEE');

    expect((await call('GET', '/transactions?limit=201', aToken)).status).toBe(400);
  });
});

describe('ingest wiring', () => {
  it('categorizes and detects transfers after a sync through the default onIngested hook', async () => {
    const a = await database.db.select().from(transactions); // none yet
    expect(a).toHaveLength(0);
    const members = await database.db.select({ id: connectors.ownerMemberId }).from(connectors);
    const [ownerA, ownerB] = [members[0]?.id as string, members[1]?.id as string];
    const base = {
      providerId: null,
      status: 'booked' as const,
      bookingDate: '2026-11-05',
      currency: 'EUR',
    };
    const seedA = await seedFakeConnector(database.db, keyring, householdId, ownerA, {
      accountRef: 'sync-a',
      transactions: [
        { ...base, amountMinor: '-1999', counterparty: 'REWE Markt', mcc: '5411' },
        { ...base, amountMinor: '-20000', counterparty: 'Own' },
      ],
    });
    const seedB = await seedFakeConnector(database.db, keyring, householdId, ownerB, {
      accountRef: 'sync-b',
      visibility: 'owner_only',
      transactions: [{ ...base, amountMinor: '20000', counterparty: 'Own' }],
    });
    for (const [seed, token] of [
      [seedA, aToken],
      [seedB, bToken],
    ] as const) {
      const res = await call('POST', `/connectors/${seed.connectorId}/sync`, token);
      expect(res.status).toBe(202);
      await app.ctx.sync.idle();
    }
    const rows = await database.db.select().from(transactions);
    expect(rows).toHaveLength(3);
    const rewe = rows.find((r) => r.mcc === '5411');
    expect(rewe).toMatchObject({ categoryId: cat['Groceries'], categorySource: 'heuristic' });
    const transfers = rows.filter((r) => r.categoryId === cat['Transfer']);
    expect(transfers).toHaveLength(2);
    expect(transfers[0]?.transferGroupId).toBe(transfers[1]?.transferGroupId);
  });
});

describe('ingest updates (R16)', () => {
  it('keeps an existing category on a booked update; categorizes rows that had none', async () => {
    const { ingest } = await import('@budgedino/server/sync/ingest');
    const { createRule, categorizeTransactions } =
      await import('@budgedino/server/categorization/rules');
    const { money } = await import('@budgedino/shared');
    const mk = (providerId: string, status: 'pending' | 'booked', counterparty: string) =>
      ({
        providerId,
        status,
        bookingDate: '2026-11-05',
        amount: money(-1_500n, 'EUR'),
        counterparty,
      }) as never;
    const run = async (txs: never[]) => {
      const res = await ingest(database.db, dk, aAccount, txs);
      await categorizeTransactions(database.db, keyring, householdId, [
        ...res.inserted,
        ...res.updated,
      ]);
      return res;
    };
    const first = await run([
      mk('k1', 'pending', 'REWE Markt'),
      mk('k2', 'pending', 'Unbekannt GmbH'),
    ]);
    const [rewe, unknown] = first.inserted as [string, string];
    expect(await row(rewe)).toMatchObject({
      categoryId: cat['Groceries'],
      categorySource: 'heuristic',
    });
    expect((await row(unknown)).categorySource).toBe('none');

    const member = (await database.db.select().from(connectors))[0]?.ownerMemberId as string;
    await createRule(database.db, dk, {
      householdId,
      createdBy: member,
      match: { counterpartyContains: 'rewe' },
      categoryId: cat['Eating out'] as string,
    });
    const second = await run([mk('k1', 'booked', 'REWE Markt'), mk('k2', 'booked', 'REWE Markt')]);
    expect(second.updated.sort()).toEqual([rewe, unknown].sort());
    expect(await row(rewe)).toMatchObject({
      categoryId: cat['Groceries'],
      categorySource: 'heuristic',
    });
    expect(await row(unknown)).toMatchObject({
      categoryId: cat['Eating out'],
      categorySource: 'rule',
    });
  });
});

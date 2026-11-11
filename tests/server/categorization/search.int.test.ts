import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '@budgedino/server/app';
import { createFakeConnector } from '@budgedino/server/connectors/fake/fake-connector';
import { createConnectorRegistry } from '@budgedino/server/connectors/registry';
import { DEFAULT_CATEGORIES } from '@budgedino/server/categorization/defaults';
import type { DataKey } from '@budgedino/server/crypto';
import { categories, transactions } from '@budgedino/server/db/schema';
import { Keyring } from '@budgedino/server/households/keyring';
import { createLogger } from '@budgedino/server/observability/logger';
import { createAccount } from '@budgedino/server/repositories/accounts';
import {
  SEARCH_BATCH,
  SEARCH_SCAN_CAP,
  createTransaction,
} from '@budgedino/server/repositories/transactions';
import {
  createHousehold,
  createTestConnector,
  createTestMember,
  createTestSession,
  randomMasterKey,
} from '../../support/factories.js';
import { startTestDatabase, type TestDatabase } from '../../support/postgres.js';

let database: TestDatabase;
let app: FastifyInstance;
let dk: DataKey;
let aToken: string;
let aAccount: string;
let bHidden: string;
let groceries: string;
let counter = 0;

type Body = Record<string, unknown> & {
  transactions: { id: string; counterparty: string | null }[];
  nextCursor: string | null;
  scannedUntil: string | null;
};

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
  const keyring = new Keyring(database.db, master);
  app = buildApp({
    db: database.db,
    keyring,
    master,
    registry: createConnectorRegistry([createFakeConnector()]),
    logger: createLogger({ level: 'silent' }),
  });
  await app.ready();
  const householdId = await createHousehold(database.db, keyring);
  dk = await keyring.forHousehold(householdId);
  await database.db.insert(categories).values(
    DEFAULT_CATEGORIES.map((c) => ({
      householdId,
      name: c.name,
      isIncome: c.isIncome ?? false,
      isTransfer: c.isTransfer ?? false,
    })),
  );
  groceries = (await database.db.select().from(categories)).find((c) => c.name === 'Groceries')
    ?.id as string;
  const a = await createTestMember(database.db, keyring, householdId, { role: 'admin' });
  const b = await createTestMember(database.db, keyring, householdId, { role: 'member' });
  aToken = await createTestSession(database.db, keyring, householdId, a);
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
  counterparty: string | undefined,
  purpose?: string,
  bookingDate = '2026-11-05',
) {
  counter += 1;
  return createTransaction(database.db, dk, {
    accountId,
    dedupKey: `s${counter}`,
    status: 'booked',
    bookingDate,
    amountMinor: -100n,
    currency: 'EUR',
    ...(counterparty === undefined ? {} : { counterparty }),
    ...(purpose === undefined ? {} : { purpose }),
  });
}

async function list(query: string) {
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/transactions?${query}`,
    headers: { authorization: `Bearer ${aToken}` },
  });
  return { status: res.statusCode, json: JSON.parse(res.body) as Body };
}

const counterparties = (json: Body) => json.transactions.map((t) => t.counterparty);

describe('GET /transactions?q=', () => {
  it('finds by counterparty and by purpose, case-insensitively', async () => {
    await add(aAccount, 'Bäckerei Müller');
    await add(aAccount, 'Kiosk', 'MÜLLER Brötchen');
    await add(aAccount, 'Other', 'nothing');
    const hit = await list('q=müller');
    expect(hit.status).toBe(200);
    expect(hit.json.transactions).toHaveLength(2);
    expect(hit.json.nextCursor).toBeNull();
    expect(hit.json.scannedUntil).toBeNull();
    expect((await list('q=MÜLLER')).json.transactions).toHaveLength(2);
    expect((await list('q=xyz')).json.transactions).toHaveLength(0);
  });

  it('treats % and _ literally', async () => {
    await add(aAccount, '50%_off shop');
    await add(aAccount, 'Fifty off shop');
    await add(aAccount, 'Plain', 'x');
    expect(counterparties((await list(`q=${encodeURIComponent('50%_')}`)).json)).toEqual([
      '50%_off shop',
    ]);
    expect(counterparties((await list(`q=${encodeURIComponent('%_')}`)).json)).toEqual([
      '50%_off shop',
    ]);
    expect(counterparties((await list(`q=${encodeURIComponent('%%')}`)).json)).toEqual([]);
    expect(counterparties((await list(`q=${encodeURIComponent('__')}`)).json)).toEqual([]);
  });

  it('trims q before applying the length bounds', async () => {
    await add(aAccount, 'Müller');
    expect((await list('q=%20%20mü%20%20')).json.transactions).toHaveLength(1);
    expect((await list('q=%20a%20')).status).toBe(400);
  });

  it('stops after the scan cap and continues with the cursor', async () => {
    expect(SEARCH_SCAN_CAP % SEARCH_BATCH).toBe(0);
    const total = SEARCH_SCAN_CAP + 200;
    // 20 rows per day, newest first: the last-inserted row is the oldest and the only match
    const dateOf = (i: number) =>
      new Date(Date.UTC(2026, 10, 5) - Math.floor(i / 20) * 86_400_000).toISOString().slice(0, 10);
    for (let at = 0; at < total; at += 100) {
      await Promise.all(
        Array.from({ length: Math.min(100, total - at) }, (_, k) => {
          const i = at + k;
          return add(
            aAccount,
            i === total - 1 ? 'Needle GmbH' : `Filler ${i}`,
            undefined,
            dateOf(i),
          );
        }),
      );
    }
    const first = await list('q=needle&limit=10');
    expect(first.status).toBe(200);
    expect(first.json.transactions).toEqual([]);
    expect(first.json.nextCursor).toEqual(expect.any(String));
    expect(first.json.scannedUntil).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const second = await list(
      `q=needle&limit=10&cursor=${encodeURIComponent(first.json.nextCursor as string)}`,
    );
    expect(counterparties(second.json)).toEqual(['Needle GmbH']);
    expect(second.json.nextCursor).toBeNull();
    expect(second.json.scannedUntil).toBeNull();
  }, 120_000);

  it('never searches invisible rows', async () => {
    await add(bHidden, 'Müller secret');
    await add(aAccount, 'Müller visible');
    expect(counterparties((await list('q=müller')).json)).toEqual(['Müller visible']);
  });

  it('rejects q shorter than 2 or longer than 64 characters', async () => {
    expect((await list('q=a')).status).toBe(400);
    expect((await list(`q=${'a'.repeat(65)}`)).status).toBe(400);
    expect((await list(`q=${'a'.repeat(64)}`)).status).toBe(200);
  });

  it('reports scannedUntil null on the plain listing', async () => {
    await add(aAccount, 'Shop');
    expect((await list('')).json.scannedUntil).toBeNull();
  });
});

describe('GET /transactions?uncategorized=', () => {
  it('returns only null categories and excludes categoryId combinations', async () => {
    const plain = await add(aAccount, 'No category');
    const categorized = await add(aAccount, 'With category');
    await database.db
      .update(transactions)
      .set({ categoryId: groceries })
      .where(eq(transactions.id, categorized));
    for (const value of ['true', '1']) {
      const res = await list(`uncategorized=${value}`);
      expect(res.status).toBe(200);
      expect(res.json.transactions.map((t) => t.id)).toEqual([plain]);
    }
    expect((await list(`uncategorized=true&categoryId=${groceries}`)).status).toBe(400);
    expect((await list('uncategorized=maybe')).status).toBe(400);
  });
});

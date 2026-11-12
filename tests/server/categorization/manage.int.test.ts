import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '@budgedino/server/app';
import { createRule } from '@budgedino/server/categorization/rules';
import type { DataKey } from '@budgedino/server/crypto';
import { categories, rules, transactions } from '@budgedino/server/db/schema';
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
import { startTestDatabase, type TestDatabase } from '../../support/postgres.js';

let database: TestDatabase;
let app: FastifyInstance;
let keyring: Keyring;
let dk: DataKey;
let householdId: string;
let aId: string;
let bId: string;
let aToken: string;
let bToken: string;
let otherToken: string;
let groceries: string;
let transfer: string;
let otherHouseholdCategory: string;

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
    logger: createLogger({ level: 'silent' }),
  });
  await app.ready();
  householdId = await createHousehold(database.db, keyring, 'A');
  const other = await createHousehold(database.db, keyring, 'B');
  dk = await keyring.forHousehold(householdId);
  const rows = await database.db
    .insert(categories)
    .values([
      { householdId, name: 'Groceries' },
      { householdId, name: 'Transfer', isTransfer: true },
      { householdId: other, name: 'Foreign' },
    ])
    .returning();
  groceries = rows.find((c) => c.name === 'Groceries')?.id as string;
  transfer = rows.find((c) => c.name === 'Transfer')?.id as string;
  otherHouseholdCategory = rows.find((c) => c.name === 'Foreign')?.id as string;
  aId = await createTestMember(database.db, keyring, householdId, { role: 'admin' });
  bId = await createTestMember(database.db, keyring, householdId, { role: 'member' });
  aToken = await createTestSession(database.db, keyring, householdId, aId);
  bToken = await createTestSession(database.db, keyring, householdId, bId);
  otherToken = await createTestSession(
    database.db,
    keyring,
    other,
    await createTestMember(database.db, keyring, other, { role: 'admin' }),
  );
});

const call = (
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  token: string,
  payload?: unknown,
) =>
  app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

describe('POST /categories', () => {
  it('creates a category (trimmed) and lists it', async () => {
    const res = await call('POST', '/categories', aToken, {
      name: '  Pets ',
      group: ' Living ',
      isIncome: false,
    });
    expect(res.statusCode).toBe(201);
    const { category } = res.json<{ category: { id: string } }>();
    expect(category).toMatchObject({
      name: 'Pets',
      group: 'Living',
      isIncome: false,
      isTransfer: false,
      archived: false,
    });
    const list = (await call('GET', '/categories', aToken)).json<{
      categories: { id: string }[];
    }>();
    expect(list.categories.map((c) => c.id)).toContain(category.id);
  });

  it('turns an empty group into null and defaults isIncome to false', async () => {
    const res = await call('POST', '/categories', aToken, { name: 'Pets', group: '  ' });
    expect(res.json<{ category: object }>().category).toMatchObject({
      group: null,
      isIncome: false,
    });
  });

  it('rejects a duplicate name in another casing with 409', async () => {
    const res = await call('POST', '/categories', aToken, { name: 'GROCERIES' });
    expect(res.statusCode).toBe(409);
  });

  it('allows a name another household already uses', async () => {
    const res = await call('POST', '/categories', otherToken, { name: 'Groceries' });
    expect(res.statusCode).toBe(201);
  });

  it('validates name and group length', async () => {
    expect((await call('POST', '/categories', aToken, { name: '' })).statusCode).toBe(400);
    expect((await call('POST', '/categories', aToken, { name: '   ' })).statusCode).toBe(400);
    expect((await call('POST', '/categories', aToken, { name: 'x'.repeat(41) })).statusCode).toBe(
      400,
    );
    expect((await call('POST', '/categories', aToken, { name: 'x'.repeat(40) })).statusCode).toBe(
      201,
    );
    expect(
      (await call('POST', '/categories', aToken, { name: 'Ok', group: 'g'.repeat(41) })).statusCode,
    ).toBe(400);
  });

  it('is admin only', async () => {
    expect((await call('POST', '/categories', bToken, { name: 'Pets' })).statusCode).toBe(403);
  });
});

describe('PATCH /categories/:id', () => {
  it('renames, regroups, archives and unarchives', async () => {
    const renamed = await call('PATCH', `/categories/${groceries}`, aToken, {
      name: 'Food',
      group: 'Living',
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json<{ category: object }>().category).toMatchObject({
      id: groceries,
      name: 'Food',
      group: 'Living',
    });
    const archived = await call('PATCH', `/categories/${groceries}`, aToken, { archived: true });
    expect(archived.json<{ category: { archived: boolean } }>().category.archived).toBe(true);
    const listed = (await call('GET', '/categories', aToken)).json<{
      categories: { id: string; archived: boolean }[];
    }>();
    expect(listed.categories.find((c) => c.id === groceries)?.archived).toBe(true);
    const back = await call('PATCH', `/categories/${groceries}`, aToken, { archived: false });
    expect(back.json<{ category: { archived: boolean } }>().category.archived).toBe(false);
    const cleared = await call('PATCH', `/categories/${groceries}`, aToken, { group: '' });
    expect(cleared.json<{ category: { group: null } }>().category.group).toBeNull();
  });

  it('allows renaming to a different casing of its own name', async () => {
    const res = await call('PATCH', `/categories/${groceries}`, aToken, { name: 'groceries' });
    expect(res.statusCode).toBe(200);
  });

  it('rejects a rename colliding with another category (409)', async () => {
    const res = await call('PATCH', `/categories/${groceries}`, aToken, { name: 'TRANSFER' });
    expect(res.statusCode).toBe(409);
  });

  it('rejects an empty body and bad names with 400', async () => {
    expect((await call('PATCH', `/categories/${groceries}`, aToken, {})).statusCode).toBe(400);
    expect(
      (await call('PATCH', `/categories/${groceries}`, aToken, { name: 'x'.repeat(41) }))
        .statusCode,
    ).toBe(400);
  });

  it('keeps the Transfer category immutable (422)', async () => {
    for (const body of [{ name: 'Moves' }, { archived: true }, { group: 'X' }]) {
      expect((await call('PATCH', `/categories/${transfer}`, aToken, body)).statusCode).toBe(422);
    }
  });

  it("answers 404 for another household's category", async () => {
    const res = await call('PATCH', `/categories/${otherHouseholdCategory}`, aToken, {
      name: 'Hijack',
    });
    expect(res.statusCode).toBe(404);
    const [row] = await database.db
      .select()
      .from(categories)
      .where(eq(categories.id, otherHouseholdCategory));
    expect(row?.name).toBe('Foreign');
  });

  it('is admin only', async () => {
    expect(
      (await call('PATCH', `/categories/${groceries}`, bToken, { name: 'Food' })).statusCode,
    ).toBe(403);
  });
});

describe('rules', () => {
  async function seedRules() {
    const a1 = await createRule(database.db, dk, {
      householdId,
      createdBy: aId,
      match: { counterpartyContains: 'REWE Markt' },
      categoryId: groceries,
    });
    const a2 = await createRule(database.db, dk, {
      householdId,
      createdBy: aId,
      match: { counterpartyIban: 'DE89370400440532013000' },
      categoryId: groceries,
    });
    const b1 = await createRule(database.db, dk, {
      householdId,
      createdBy: bId,
      match: { counterpartyContains: 'SECRET-B-PAYEE' },
      categoryId: groceries,
    });
    return { a1, a2, b1 };
  }

  it('lists only the caller own rules with decrypted match', async () => {
    const { a1, a2, b1 } = await seedRules();
    const res = await call('GET', '/rules', aToken);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('SECRET-B-PAYEE');
    const body = res.json<{
      rules: { id: string; categoryId: string; match: object; createdAt: string }[];
    }>();
    expect(body.rules.map((r) => r.id).sort()).toEqual([a1.id, a2.id].sort());
    expect(body.rules.find((r) => r.id === a1.id)).toMatchObject({
      categoryId: groceries,
      match: { kind: 'counterpartyContains', value: 'REWE Markt' },
    });
    expect(body.rules.find((r) => r.id === a2.id)?.match).toEqual({
      kind: 'iban',
      value: 'DE89370400440532013000',
    });
    expect(Number.isNaN(Date.parse(body.rules[0]?.createdAt as string))).toBe(false);
    const bList = (await call('GET', '/rules', bToken)).json<{ rules: { id: string }[] }>();
    expect(bList.rules.map((r) => r.id)).toEqual([b1.id]);
  });

  it('deletes an own rule (204) and it disappears from the list', async () => {
    const { a1 } = await seedRules();
    const res = await call('DELETE', `/rules/${a1.id}`, aToken);
    expect(res.statusCode).toBe(204);
    const list = (await call('GET', '/rules', aToken)).json<{ rules: { id: string }[] }>();
    expect(list.rules.map((r) => r.id)).not.toContain(a1.id);
    expect(await database.db.select().from(rules).where(eq(rules.id, a1.id))).toHaveLength(0);
  });

  it('leaves transactions categorized by the rule untouched after deletion', async () => {
    const { a1 } = await seedRules();
    const connector = await createTestConnector(database.db, keyring, householdId, aId);
    const accountId = await createAccount(database.db, dk, {
      connectorId: connector,
      ownerMemberId: aId,
      externalRef: 'x',
      name: 'A',
      kind: 'checking',
      currency: 'EUR',
    });
    const tx = await createTransaction(database.db, dk, {
      accountId,
      dedupKey: 'one',
      status: 'booked',
      bookingDate: '2026-11-05',
      amountMinor: -100n,
      currency: 'EUR',
      counterparty: 'REWE Markt',
    });
    await database.db
      .update(transactions)
      .set({ categoryId: groceries, categorySource: 'rule' })
      .where(eq(transactions.id, tx));
    expect((await call('DELETE', `/rules/${a1.id}`, aToken)).statusCode).toBe(204);
    const [row] = await database.db.select().from(transactions).where(eq(transactions.id, tx));
    expect(row?.categoryId).toBe(groceries);
  });

  it("answers 404 for another member's rule and keeps it", async () => {
    const { b1 } = await seedRules();
    const res = await call('DELETE', `/rules/${b1.id}`, aToken);
    expect(res.statusCode).toBe(404);
    expect(await database.db.select().from(rules).where(eq(rules.id, b1.id))).toHaveLength(1);
  });

  it('answers 404 for an unknown rule and for another household', async () => {
    const { a1 } = await seedRules();
    expect(
      (await call('DELETE', '/rules/00000000-0000-4000-8000-000000000000', aToken)).statusCode,
    ).toBe(404);
    expect((await call('DELETE', `/rules/${a1.id}`, otherToken)).statusCode).toBe(404);
  });
});

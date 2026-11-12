import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '@budgedino/server/app';
import { categories } from '@budgedino/server/db/schema';
import { Keyring } from '@budgedino/server/households/keyring';
import { createLogger } from '@budgedino/server/observability/logger';
import {
  createHousehold,
  createTestMember,
  createTestSession,
  randomMasterKey,
} from '../../support/factories.js';
import { startTestDatabase, type TestDatabase } from '../../support/postgres.js';

let database: TestDatabase;
let app: FastifyInstance;
let aToken: string;
let bToken: string;

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
    logger: createLogger({ level: 'silent' }),
  });
  await app.ready();
  const hA = await createHousehold(database.db, keyring, 'A');
  const hB = await createHousehold(database.db, keyring, 'B');
  await database.db.insert(categories).values([
    { householdId: hA, name: 'Groceries', group: 'Living' },
    { householdId: hA, name: 'Archived one', archived: true },
    { householdId: hA, name: 'Salary', isIncome: true },
    { householdId: hB, name: 'OTHER-HOUSEHOLD-CANARY' },
  ]);
  aToken = await createTestSession(
    database.db,
    keyring,
    hA,
    await createTestMember(database.db, keyring, hA, { role: 'member' }),
  );
  bToken = await createTestSession(
    database.db,
    keyring,
    hB,
    await createTestMember(database.db, keyring, hB, { role: 'member' }),
  );
});

const list = (token?: string) =>
  app.inject({
    method: 'GET',
    url: '/api/v1/categories',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

describe('GET /categories', () => {
  it("returns the caller's household categories only, ordered by name", async () => {
    const res = await list(aToken);
    expect(res.statusCode).toBe(200);
    const body = res.json<{ categories: { name: string; archived: boolean }[] }>();
    expect(body.categories.map((c) => c.name)).toEqual(['Archived one', 'Groceries', 'Salary']);
    expect(body.categories.find((c) => c.name === 'Archived one')?.archived).toBe(true);
    expect(res.body).not.toContain('OTHER-HOUSEHOLD-CANARY');
  });

  it('does not show household A to a member of household B', async () => {
    const res = await list(bToken);
    expect(res.json<{ categories: { name: string }[] }>().categories.map((c) => c.name)).toEqual([
      'OTHER-HOUSEHOLD-CANARY',
    ]);
    expect(res.body).not.toContain('Groceries');
  });

  it('requires authentication', async () => {
    expect((await list()).statusCode).toBe(401);
  });
});

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '@budgedino/server/app';
import { createDb } from '@budgedino/server/db/client';
import { migrate } from '@budgedino/server/db/migrate';
import { categories } from '@budgedino/server/db/schema';
import { bootstrapHousehold } from '@budgedino/server/households/bootstrap';
import { Keyring } from '@budgedino/server/households/keyring';
import { createLogger } from '@budgedino/server/observability/logger';
import { createTestMember, createTestSession, randomMasterKey } from '../../support/factories.js';
import { startTestDatabase, type TestDatabase } from '../../support/postgres.js';

let database: TestDatabase;
let app: FastifyInstance;
let keyring: Keyring;
let householdId: string;
let token: string;

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
  ({ householdId } = await bootstrapHousehold(
    { db: database.db, keyring },
    { name: 'H', timezone: 'Europe/Berlin' },
  ));
  token = await createTestSession(
    database.db,
    keyring,
    householdId,
    await createTestMember(database.db, keyring, householdId, { role: 'admin' }),
  );
});

const call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

interface Cat {
  id: string;
  name: string;
  icon: string | null;
  color: string | null;
  key?: unknown;
}

describe('default category style', () => {
  it('new households get key, icon and colour for all 19 defaults', async () => {
    const rows = await database.db
      .select()
      .from(categories)
      .where(eq(categories.householdId, householdId));
    expect(rows).toHaveLength(19);
    for (const r of rows) {
      expect(r.key).toBeTruthy();
      expect(r.icon).toBeTruthy();
      expect(r.color).toBeTruthy();
    }
    const by = (name: string) => rows.find((r) => r.name === name);
    expect(by('Groceries')).toMatchObject({ key: 'groceries', icon: 'cart', color: 'green' });
    expect(by('Transfer')).toMatchObject({
      key: 'transfer',
      icon: 'swap-horizontal',
      color: 'grey',
    });
  });

  it('GET /categories returns icon and colour but never the key', async () => {
    const res = await call('GET', '/categories');
    const { categories: list } = res.json<{ categories: Cat[] }>();
    expect(list.find((c) => c.name === 'Groceries')).toMatchObject({
      icon: 'cart',
      color: 'green',
    });
    expect(list.every((c) => !('key' in c))).toBe(true);
  });
});

describe('POST/PATCH /categories icon and colour', () => {
  it('stores icon and colour on create, clears them with null on patch', async () => {
    const created = await call('POST', '/categories', {
      name: 'Pets',
      icon: 'dog',
      color: 'brown',
    });
    expect(created.statusCode).toBe(201);
    const cat = created.json<{ category: Cat }>().category;
    expect(cat).toMatchObject({ icon: 'dog', color: 'brown' });

    const patched = await call('PATCH', `/categories/${cat.id}`, { color: null });
    expect(patched.statusCode).toBe(200);
    expect(patched.json<{ category: Cat }>().category).toMatchObject({
      icon: 'dog',
      color: null,
    });

    const set = await call('PATCH', `/categories/${cat.id}`, { icon: 'coffee', color: 'teal' });
    expect(set.json<{ category: Cat }>().category).toMatchObject({
      icon: 'coffee',
      color: 'teal',
    });
    const cleared = await call('PATCH', `/categories/${cat.id}`, { icon: null });
    expect(cleared.json<{ category: Cat }>().category).toMatchObject({
      icon: null,
      color: 'teal',
    });
  });

  it('leaves them null when omitted', async () => {
    const res = await call('POST', '/categories', { name: 'Plain' });
    expect(res.json<{ category: Cat }>().category).toMatchObject({ icon: null, color: null });
  });

  it('rejects an icon or colour outside the allowlists', async () => {
    expect((await call('POST', '/categories', { name: 'X', icon: 'not-an-icon' })).statusCode).toBe(
      400,
    );
    expect((await call('POST', '/categories', { name: 'X', color: '#ff0000' })).statusCode).toBe(
      400,
    );
    const groceries = await database.db
      .select()
      .from(categories)
      .where(and(eq(categories.householdId, householdId), eq(categories.name, 'Groceries')));
    const id = groceries[0]?.id;
    expect((await call('PATCH', `/categories/${id}`, { icon: 'nope' })).statusCode).toBe(400);
  });

  it('never accepts key from the client', async () => {
    const res = await call('POST', '/categories', { name: 'Sneaky', key: 'groceries' });
    expect(res.statusCode).toBe(201);
    const [row] = await database.db.select().from(categories).where(eq(categories.name, 'Sneaky'));
    expect(row?.key).toBeNull();
    const patched = await call('PATCH', `/categories/${row?.id}`, { key: 'income', name: 'S2' });
    expect(patched.statusCode).toBe(200);
    const [after] = await database.db.select().from(categories).where(eq(categories.name, 'S2'));
    expect(after?.key).toBeNull();
  });
});

describe('migration 0013 backfill', () => {
  let container: StartedPostgreSqlContainer;
  let tmp: string;

  afterAll(async () => {
    await container?.stop();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it('backfills unambiguous default names only', async () => {
    const drizzleDir = fileURLToPath(new URL('../../../src/server/drizzle', import.meta.url));
    tmp = mkdtempSync(join(tmpdir(), 'budgedino-mig-'));
    cpSync(drizzleDir, tmp, { recursive: true });
    // Only migrations up to 0012 first.
    const journalPath = join(tmp, 'meta', '_journal.json');
    const full = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries: { idx: number }[];
    };
    writeFileSync(
      journalPath,
      JSON.stringify({ ...full, entries: full.entries.filter((e) => e.idx <= 12) }),
    );

    container = await new PostgreSqlContainer('postgres:18').start();
    const handle = createDb(container.getConnectionUri());
    try {
      await migrate(handle.pool, tmp);
      const hh = '11111111-1111-4111-8111-111111111111';
      await handle.pool.query(`insert into households (id, name) values ($1, 'old')`, [hh]);
      for (const name of [
        'Lebensmittel', // Groceries renamed
        'Eating out',
        'Cash',
        'Cash', // ambiguous
      ]) {
        await handle.pool.query(
          `insert into categories (id, household_id, name) values (gen_random_uuid(), $1, $2)`,
          [hh, name],
        );
      }

      writeFileSync(journalPath, JSON.stringify(full));
      await migrate(handle.pool, tmp);

      const { rows } = await handle.pool.query<{
        name: string;
        key: string | null;
        icon: string | null;
        color: string | null;
      }>(`select name, key, icon, color from categories order by name`);
      const eating = rows.find((r) => r.name === 'Eating out');
      expect(eating).toMatchObject({
        key: 'eating-out',
        icon: 'silverware-fork-knife',
        color: 'orange',
      });
      const rest = rows.filter((r) => r.name !== 'Eating out');
      expect(rest).toHaveLength(3);
      for (const r of rest) expect(r).toMatchObject({ key: null, icon: null, color: null });
    } finally {
      await handle.close();
    }
  }, 120_000);
});

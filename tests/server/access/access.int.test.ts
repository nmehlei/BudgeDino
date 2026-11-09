import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '@budgedino/server/app';
import {
  ABSOLUTE_SESSION_LIFETIME_MS,
  IDLE_SESSION_TIMEOUT_MS,
} from '@budgedino/server/auth/session-policy';
import type { MasterKey } from '@budgedino/server/crypto';
import { Keyring } from '@budgedino/server/households/keyring';
import { createLogger } from '@budgedino/server/observability/logger';
import {
  createHousehold,
  createTestMember,
  createTestSession,
  randomMasterKey,
} from '../../support/factories.js';
import { startTestDatabase, type TestDatabase } from '../../support/postgres.js';

const DAY = 24 * 60 * 60 * 1000;

let database: TestDatabase;
let master: MasterKey;
let keyring: Keyring;
let nowMs: number;
const apps: FastifyInstance[] = [];

beforeAll(async () => {
  database = await startTestDatabase();
}, 120_000);

afterAll(async () => {
  await Promise.all(apps.map((a) => a.close()));
  await database.stop();
});

beforeEach(async () => {
  await database.reset();
  nowMs = Date.UTC(2026, 10, 9, 12, 0, 0);
  master = randomMasterKey();
  keyring = new Keyring(database.db, master);
});

function build(): FastifyInstance {
  const app = buildApp({
    db: database.db,
    keyring,
    master,
    logger: createLogger({ level: 'silent' }),
    now: () => new Date(nowMs),
  });
  apps.push(app);
  return app;
}

describe('fail-closed route access', () => {
  it('refuses to start when a route declares no config.access', async () => {
    const app = build();
    void app.register(async (i) => {
      i.get('/oops', async () => 'x');
    });
    await expect(app.ready()).rejects.toThrow(/access/);
  });

  it('attaches the admin guard itself: members get 403, admins pass', async () => {
    const app = build();
    void app.register(async (i) => {
      i.get('/only-admin', { config: { access: 'admin' } }, async () => ({ ok: true }));
      i.get('/any-member', { config: { access: 'member' } }, async () => ({ ok: true }));
      i.get('/open', { config: { access: 'public' } }, async () => ({ ok: true }));
    });
    await app.ready();
    const householdId = await createHousehold(database.db, keyring);
    const admin = await createTestMember(database.db, keyring, householdId, { role: 'admin' });
    const member = await createTestMember(database.db, keyring, householdId, { role: 'member' });
    const adminToken = await createTestSession(
      database.db,
      keyring,
      householdId,
      admin,
      new Date(nowMs),
    );
    const memberToken = await createTestSession(
      database.db,
      keyring,
      householdId,
      member,
      new Date(nowMs),
    );
    const get = async (url: string, token?: string) =>
      (
        await app.inject({
          method: 'GET',
          url,
          headers: token ? { authorization: `Bearer ${token}` } : {},
        })
      ).statusCode;

    expect(await get('/only-admin', memberToken)).toBe(403);
    expect(await get('/only-admin', adminToken)).toBe(200);
    expect(await get('/only-admin')).toBe(401);
    expect(await get('/any-member', memberToken)).toBe(200);
    expect(await get('/any-member')).toBe(401);
    expect(await get('/open')).toBe(200);
  });

  it('authenticates before validating: anonymous + invalid body to a member route is 401, not 400', async () => {
    const app = build();
    await app.ready();
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/auth/sessions/not-a-uuid',
    });
    expect(res.statusCode).toBe(401);
    const admin = await app.inject({
      method: 'POST',
      url: '/api/v1/households/invites',
      payload: { role: 'nonsense' },
    });
    expect(admin.statusCode).toBe(401);
  });

  it('exposes every GET route in the route registry', async () => {
    const app = build();
    await app.ready();
    const gets = app.routeRegistry.filter((r) => r.method === 'GET').map((r) => r.url);
    expect(gets).toEqual(expect.arrayContaining(['/api/v1/auth/sessions', '/api/v1/accounts']));
  });
});

describe('session expiry', () => {
  async function setup() {
    const app = build();
    await app.ready();
    const householdId = await createHousehold(database.db, keyring);
    const memberId = await createTestMember(database.db, keyring, householdId);
    const token = await createTestSession(
      database.db,
      keyring,
      householdId,
      memberId,
      new Date(nowMs),
    );
    const status = async (t: string) =>
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/auth/sessions',
          headers: { authorization: `Bearer ${t}` },
        })
      ).statusCode;
    return { app, token, status };
  }

  it('uses 90 days idle and 365 days absolute', () => {
    expect(IDLE_SESSION_TIMEOUT_MS).toBe(90 * DAY);
    expect(ABSOLUTE_SESSION_LIFETIME_MS).toBe(365 * DAY);
  });

  it('rejects a session idle for more than 90 days, identical to an invalid token', async () => {
    const { app, token, status } = await setup();
    nowMs += 89 * DAY;
    expect(await status(token)).toBe(200);
    nowMs += 89 * DAY; // last seen refreshed 89 days ago: still within idle
    expect(await status(token)).toBe(200);
    nowMs += 91 * DAY;
    const expired = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/sessions',
      headers: { authorization: `Bearer ${token}` },
    });
    const invalid = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/sessions',
      headers: { authorization: `Bearer ${'A'.repeat(43)}` },
    });
    expect(expired.statusCode).toBe(401);
    expect(expired.body).toBe(invalid.body);
  });

  it('rejects a continuously used session after 365 days', async () => {
    const { token, status } = await setup();
    for (let i = 0; i < 12; i++) {
      nowMs += 30 * DAY;
      expect(await status(token)).toBe(200);
    }
    nowMs += 5 * DAY; // 365 days total
    expect(await status(token)).toBe(200);
    nowMs += 1 * DAY + 1;
    expect(await status(token)).toBe(401);
  });
});

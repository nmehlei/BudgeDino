import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '@budgedino/server/app';
import { createFakeConnector } from '@budgedino/server/connectors/fake/fake-connector';
import { createConnectorRegistry } from '@budgedino/server/connectors/registry';
import { invites, members } from '@budgedino/server/db/schema';
import { Keyring } from '@budgedino/server/households/keyring';
import { createInvite } from '@budgedino/server/households/invites';
import { createLogger } from '@budgedino/server/observability/logger';
import {
  createHousehold,
  createTestMember,
  createTestSession,
  randomMasterKey,
} from '../../support/factories.js';
import { startTestDatabase, type TestDatabase } from '../../support/postgres.js';

const DAY_MS = 24 * 3600 * 1000;

let database: TestDatabase;
let keyring: Keyring;
let app: FastifyInstance;
let householdId: string;
let otherHouseholdId: string;
let adminId: string;
let memberId: string;
let adminToken: string;
let memberToken: string;
let now: Date;

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
  now = new Date();
  householdId = await createHousehold(database.db, keyring);
  otherHouseholdId = await createHousehold(database.db, keyring);
  adminId = await createTestMember(database.db, keyring, householdId, {
    role: 'admin',
    displayName: 'Alice Admin',
    email: 'alice@example.test',
  });
  memberId = await createTestMember(database.db, keyring, householdId, {
    role: 'member',
    displayName: 'Bob Member',
    email: 'bob@example.test',
  });
  await createTestMember(database.db, keyring, otherHouseholdId, {
    displayName: 'Mallory Other',
    email: 'mallory@example.test',
  });
  adminToken = await createTestSession(database.db, keyring, householdId, adminId);
  memberToken = await createTestSession(database.db, keyring, householdId, memberId);
});

async function call(method: 'GET' | 'DELETE', url: string, token: string) {
  const res = await app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { authorization: `Bearer ${token}` },
  });
  return {
    status: res.statusCode,
    body: res.body,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed response bodies in tests
    json: (res.body ? JSON.parse(res.body) : null) as Record<string, any>,
  };
}

/** Creates an invite and returns its row id plus the one-time token. */
async function seedInvite(
  hid: string,
  opts: { role?: 'admin' | 'member'; createdAt?: Date; used?: boolean } = {},
) {
  const created = await createInvite(database.db, {
    householdId: hid,
    role: opts.role ?? 'member',
    now: opts.createdAt ?? now,
  });
  const rows = await database.db.select().from(invites);
  const row = rows.find(
    (r) => r.expiresAt.getTime() === created.expiresAt.getTime() && !seen.has(r.id),
  );
  if (!row) throw new Error('invite row not found');
  seen.add(row.id);
  if (opts.used)
    await database.db.update(invites).set({ usedAt: now }).where(eq(invites.id, row.id));
  return {
    id: row.id,
    token: created.token,
    tokenHash: row.tokenHash,
    expiresAt: created.expiresAt,
  };
}
const seen = new Set<string>();

describe('GET /households/members', () => {
  it('lists the household for a member without emails', async () => {
    const res = await call('GET', '/households/members', memberToken);
    expect(res.status).toBe(200);
    expect(res.json.members).toHaveLength(2);
    expect(res.body).not.toContain('example.test');
    expect(res.body).not.toContain('Mallory');
    const bob = res.json.members.find((m: { id: string }) => m.id === memberId);
    expect(bob).toMatchObject({
      displayName: 'Bob Member',
      role: 'member',
      isSelf: true,
      disabled: false,
    });
    expect(new Date(bob.joinedAt).toISOString()).toBe(bob.joinedAt);
    expect(bob).not.toHaveProperty('email');
    const alice = res.json.members.find((m: { id: string }) => m.id === adminId);
    expect(alice.isSelf).toBe(false);
  });

  it('adds email for an admin and orders by joinedAt', async () => {
    const res = await call('GET', '/households/members', adminToken);
    expect(res.status).toBe(200);
    expect(res.json.members.map((m: { id: string }) => m.id)).toEqual([adminId, memberId]);
    expect(res.json.members[0].email).toBe('alice@example.test');
    expect(res.json.members[1].email).toBe('bob@example.test');
  });

  it('reflects a disabled member', async () => {
    await database.db.update(members).set({ disabledAt: now }).where(eq(members.id, memberId));
    const res = await call('GET', '/households/members', adminToken);
    const bob = res.json.members.find((m: { id: string }) => m.id === memberId);
    expect(bob.disabled).toBe(true);
  });
});

describe('invites', () => {
  beforeEach(() => seen.clear());

  it('lists only pending invites of the own household, never a token or hash', async () => {
    const pending = await seedInvite(householdId, { role: 'member' });
    const used = await seedInvite(householdId, { used: true });
    const expired = await seedInvite(householdId, {
      createdAt: new Date(now.getTime() - 30 * DAY_MS),
    });
    const foreign = await seedInvite(otherHouseholdId);

    const res = await call('GET', '/households/invites', adminToken);
    expect(res.status).toBe(200);
    expect(res.json.invites).toEqual([
      { id: pending.id, role: 'member', expiresAt: pending.expiresAt.toISOString() },
    ]);
    for (const i of [pending, used, expired, foreign]) {
      expect(res.body).not.toContain(i.token);
      expect(res.body).not.toContain(i.tokenHash);
    }
  });

  it('forbids members from listing and deleting', async () => {
    const inv = await seedInvite(householdId);
    expect((await call('GET', '/households/invites', memberToken)).status).toBe(403);
    expect((await call('DELETE', `/households/invites/${inv.id}`, memberToken)).status).toBe(403);
    expect(await database.db.select().from(invites)).toHaveLength(1);
  });

  it('deletes a pending invite (204) and it is gone', async () => {
    const inv = await seedInvite(householdId);
    expect((await call('DELETE', `/households/invites/${inv.id}`, adminToken)).status).toBe(204);
    expect((await call('GET', '/households/invites', adminToken)).json.invites).toEqual([]);
    expect(await database.db.select().from(invites)).toHaveLength(0);
  });

  it('answers 409 for a used invite and keeps it', async () => {
    const inv = await seedInvite(householdId, { used: true });
    expect((await call('DELETE', `/households/invites/${inv.id}`, adminToken)).status).toBe(409);
    expect(await database.db.select().from(invites)).toHaveLength(1);
  });

  it('answers 404 for expired, unknown and foreign invites', async () => {
    const expired = await seedInvite(householdId, {
      createdAt: new Date(now.getTime() - 30 * DAY_MS),
    });
    const foreign = await seedInvite(otherHouseholdId);
    for (const id of [expired.id, foreign.id, '00000000-0000-7000-8000-000000000000']) {
      expect((await call('DELETE', `/households/invites/${id}`, adminToken)).status).toBe(404);
    }
    expect(await database.db.select().from(invites)).toHaveLength(2);
  });
});

import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '@budgedino/server/app';
import { createFakeConnector } from '@budgedino/server/connectors/fake/fake-connector';
import { createConnectorRegistry } from '@budgedino/server/connectors/registry';
import { connectors, households, syncRuns } from '@budgedino/server/db/schema';
import { Keyring } from '@budgedino/server/households/keyring';
import { createLogger } from '@budgedino/server/observability/logger';
import { tick } from '@budgedino/server/sync/jobs';
import type { SyncDeps } from '@budgedino/server/sync/run';
import {
  createHousehold,
  createTestMember,
  createTestSession,
  randomMasterKey,
} from '../../support/factories.js';
import { startTestDatabase, type TestDatabase } from '../../support/postgres.js';
import { seedFakeConnector } from '../../support/sync.js';

let database: TestDatabase;
let keyring: Keyring;
let app: FastifyInstance;
let householdId: string;
let aId: string;
let bId: string;
let aToken: string;
let bToken: string;

beforeAll(async () => {
  database = await startTestDatabase();
}, 120_000);
afterAll(async () => {
  await app?.close();
  await database.stop();
});

const registry = createConnectorRegistry([
  createFakeConnector({
    rateLimit: { maxUnattendedPerDay: 4, defaultSchedule: { times: ['12:00'] } },
  }),
]);

beforeEach(async () => {
  await app?.close();
  await database.reset();
  const master = randomMasterKey();
  keyring = new Keyring(database.db, master);
  app = buildApp({
    db: database.db,
    keyring,
    master,
    registry,
    logger: createLogger({ level: 'silent' }),
    now: () => new Date('2026-11-09T12:00:00Z'),
  });
  await app.ready();
  householdId = await createHousehold(database.db, keyring);
  aId = await createTestMember(database.db, keyring, householdId, { role: 'admin' });
  bId = await createTestMember(database.db, keyring, householdId, { role: 'member' });
  aToken = await createTestSession(database.db, keyring, householdId, aId);
  bToken = await createTestSession(database.db, keyring, householdId, bId);
});

const call = (method: 'GET' | 'POST', url: string, token: string) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` } });

describe('POST /connectors/:id/sync', () => {
  it('returns 202 with a runId for the owner and runs the sync as a user-present run', async () => {
    const { connectorId } = await seedFakeConnector(database.db, keyring, householdId, bId);
    const res = await call('POST', `/connectors/${connectorId}/sync`, bToken);
    expect(res.statusCode).toBe(202);
    const { runId } = res.json<{ runId: string }>();
    await app.ctx.sync.idle();
    const [run] = await database.db.select().from(syncRuns).where(eq(syncRuns.id, runId));
    expect(run).toMatchObject({ trigger: 'user', userPresent: true, outcome: 'ok' });
  });

  it('coalesces onto a queued or active run and throttles user runs to one per 2 minutes', async () => {
    const { connectorId } = await seedFakeConnector(database.db, keyring, householdId, bId);
    const queued = await database.db
      .insert(syncRuns)
      .values({
        connectorId,
        trigger: 'schedule',
        startedAt: new Date('2026-11-09T11:55:00Z'),
      })
      .returning({ id: syncRuns.id });
    const coalesced = await call('POST', `/connectors/${connectorId}/sync`, bToken);
    expect(coalesced.statusCode).toBe(202);
    expect(coalesced.json<{ runId: string }>().runId).toBe(queued[0]?.id);
    expect(await database.db.select().from(syncRuns)).toHaveLength(1);

    // no active run any more: the first user run starts, the second within 2 minutes is throttled
    await database.db.update(syncRuns).set({ outcome: 'ok' });
    const first = await call('POST', `/connectors/${connectorId}/sync`, bToken);
    expect(first.statusCode).toBe(202);
    await app.ctx.sync.idle();
    const second = await call('POST', `/connectors/${connectorId}/sync`, bToken);
    expect(second.statusCode).toBe(429);
    expect(second.headers['retry-after']).toBe('120');
    expect(second.json<{ error: string }>().error).toBe('sync_throttled');
    expect(await database.db.select().from(syncRuns)).toHaveLength(2);
  });

  it('answers 404 for another member (admin included) and for unknown ids, without starting a run', async () => {
    const { connectorId } = await seedFakeConnector(database.db, keyring, householdId, bId);
    const other = await call('POST', `/connectors/${connectorId}/sync`, aToken);
    expect(other.statusCode).toBe(404);
    const unknown = await call(
      'POST',
      `/connectors/${'00000000-0000-4000-8000-000000000000'}/sync`,
      aToken,
    );
    expect(unknown.statusCode).toBe(404);
    expect(other.body).toBe(unknown.body);
    expect(await database.db.select().from(syncRuns)).toHaveLength(0);
  });

  it('requires authentication', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/connectors/00000000-0000-4000-8000-000000000000/sync',
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /connectors', () => {
  it('shows own connectors in full and others only when a household-visible account exists, minimally', async () => {
    const mine = await seedFakeConnector(database.db, keyring, householdId, aId, {
      scenario: 'expired-consent',
    });
    const shared = await seedFakeConnector(database.db, keyring, householdId, bId, {
      accountRef: 'b-1',
    });
    const hidden = await seedFakeConnector(database.db, keyring, householdId, bId, {
      accountRef: 'b-2',
      visibility: 'owner_only',
    });
    await database.db
      .update(connectors)
      .set({ lastErrorCode: 'secret_code', consentExpiresAt: new Date('2027-01-01T00:00:00Z') })
      .where(eq(connectors.id, shared.connectorId));

    const res = await call('GET', '/connectors', aToken);
    expect(res.statusCode).toBe(200);
    const list = res.json<{ connectors: Record<string, unknown>[] }>().connectors;
    const byId = new Map(list.map((c) => [c['id'], c]));
    expect(byId.has(hidden.connectorId)).toBe(false);
    expect(byId.get(mine.connectorId)).toMatchObject({
      type: 'fake',
      status: 'ok',
      isOwner: true,
      experimental: false,
      lastSuccessAt: null,
      lastErrorCode: null,
      consentExpiresAt: null,
    });
    expect(byId.get(shared.connectorId)).toEqual({
      id: shared.connectorId,
      type: 'fake',
      status: 'ok',
      lastSuccessAt: null,
      isOwner: false,
    });

    const asB = await call('GET', '/connectors', bToken);
    const bList = asB.json<{ connectors: Record<string, unknown>[] }>().connectors;
    const bById = new Map(bList.map((c) => [c['id'], c]));
    expect(bById.has(hidden.connectorId)).toBe(true);
    expect(bById.get(shared.connectorId)).toMatchObject({
      lastErrorCode: 'secret_code',
      consentExpiresAt: '2027-01-01T00:00:00.000Z',
    });
  });
});

describe('tick', () => {
  const deps = (): SyncDeps => ({
    db: database.db,
    keyring,
    registry,
    logger: createLogger({ level: 'silent' }),
    now: () => new Date('2026-11-09T11:02:00Z'), // 12:02 Berlin
    onIngested: async () => {},
  });

  it('enqueues only ok connectors that are due, and not again once they ran', async () => {
    const due = await seedFakeConnector(database.db, keyring, householdId, aId);
    const attention = await seedFakeConnector(database.db, keyring, householdId, aId, {
      accountRef: 'x',
    });
    const disabled = await seedFakeConnector(database.db, keyring, householdId, aId, {
      accountRef: 'y',
    });
    await database.db
      .update(connectors)
      .set({ status: 'needs_attention' })
      .where(eq(connectors.id, attention.connectorId));
    await database.db
      .update(connectors)
      .set({ status: 'disabled' })
      .where(eq(connectors.id, disabled.connectorId));
    await database.db.update(households).set({ timezone: 'Europe/Berlin' });

    const enqueued: string[] = [];
    const enqueue = async (id: string) => {
      enqueued.push(id);
    };
    expect(await tick(deps(), enqueue)).toEqual([due.connectorId]);

    // after a scheduled run at 12:02 the 12:00 occurrence is served
    await database.db.insert(syncRuns).values({
      connectorId: due.connectorId,
      trigger: 'schedule',
      startedAt: new Date('2026-11-09T11:01:00Z'),
      outcome: 'ok',
    });
    expect(await tick(deps(), enqueue)).toEqual([]);
  });
});

import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '@budgedino/server/app';
import { expireChallenges } from '@budgedino/server/connectors/challenge-service';
import { createFakeConnector } from '@budgedino/server/connectors/fake/fake-connector';
import { createConnectorRegistry } from '@budgedino/server/connectors/registry';
import type { Connector } from '@budgedino/server/connectors/types';
import { runSync } from '@budgedino/server/sync/run';
import {
  accounts,
  challenges,
  connectors,
  notifications,
  syncRuns,
} from '@budgedino/server/db/schema';
import {
  decryptConnectorState,
  encryptConnectorState,
} from '@budgedino/server/repositories/connectors';
import { ConnectorAuthError } from '@budgedino/server/connectors/types';
import { Keyring } from '@budgedino/server/households/keyring';
import { createLogger } from '@budgedino/server/observability/logger';
import {
  createHousehold,
  createTestMember,
  createTestSession,
  randomMasterKey,
} from '../../support/factories.js';
import { startTestDatabase, type TestDatabase } from '../../support/postgres.js';

const MARKER = 'DIALOG-MARKER-9f3a';
const T0 = new Date('2026-11-09T12:00:00Z').getTime();

let database: TestDatabase;
let keyring: Keyring;
let app: FastifyInstance;
let nowMs: number;
let aToken: string;
let bToken: string;
let cancelCalls: number;
let continueCalls: number;
let continueDelayMs: number;
let cancelUserPresent: boolean[];
let fetchGate: Promise<void> | null;
let fetchThrows: boolean;
let startMode: 'ok' | 'fail' | 'refuse';

beforeAll(async () => {
  database = await startTestDatabase();
}, 120_000);
afterAll(async () => {
  await app?.close();
  await database.stop();
});

/** Fake connector (type `spy`) that counts bank calls and can be slowed down. */
function spyConnector(): Connector {
  const fake = createFakeConnector();
  return {
    ...fake,
    type: 'spy',
    async continueAuth(dialog, answer, ctx) {
      continueCalls += 1;
      if (continueDelayMs > 0) await new Promise((r) => setTimeout(r, continueDelayMs));
      return fake.continueAuth(dialog, answer, ctx);
    },
    async cancelAuth(_dialog, ctx) {
      cancelCalls += 1;
      cancelUserPresent.push(ctx.userPresent);
    },
    async fetchTransactions(state, ref, since, ctx) {
      if (fetchGate) await fetchGate;
      if (fetchThrows) throw new Error('fetch crashed');
      return fake.fetchTransactions(state, ref, since, ctx);
    },
  };
}

/** Fake connector (type `flaky-start`) whose startAuth can be made to fail. */
function flakyStartConnector(): Connector {
  const fake = createFakeConnector();
  return {
    ...fake,
    type: 'flaky-start',
    async startAuth(config, ctx) {
      if (startMode === 'fail') throw new Error('bank down');
      if (startMode === 'refuse') throw new ConnectorAuthError('declined');
      return fake.startAuth(config, ctx);
    },
  };
}

beforeEach(async () => {
  await app?.close();
  await database.reset();
  nowMs = T0;
  cancelCalls = 0;
  continueCalls = 0;
  continueDelayMs = 0;
  cancelUserPresent = [];
  fetchGate = null;
  fetchThrows = false;
  startMode = 'ok';
  const master = randomMasterKey();
  keyring = new Keyring(database.db, master);
  app = buildApp({
    db: database.db,
    keyring,
    master,
    registry: createConnectorRegistry([
      createFakeConnector(),
      spyConnector(),
      flakyStartConnector(),
    ]),
    logger: createLogger({ level: 'silent' }),
    now: () => new Date(nowMs),
  });
  await app.ready();
  const householdId = await createHousehold(database.db, keyring);
  const aId = await createTestMember(database.db, keyring, householdId, { role: 'admin' });
  const bId = await createTestMember(database.db, keyring, householdId, { role: 'member' });
  aToken = await createTestSession(database.db, keyring, householdId, aId);
  bToken = await createTestSession(database.db, keyring, householdId, bId);
});

interface Res {
  status: number;
  body: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: Record<string, any>;
  headers: Record<string, unknown>;
}
async function call(
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  token: string,
  payload?: object,
): Promise<Res> {
  const res = await app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { authorization: `Bearer ${token}` },
    ...(payload ? { payload } : {}),
  });
  return {
    status: res.statusCode,
    body: res.body,
    json: JSON.parse(res.body || 'null') as Res['json'],
    headers: res.headers,
  };
}

const connect = (token: string, config: object, type = 'fake') =>
  call('POST', '/connectors', token, { type, config });
const answer = (token: string, id: string, payload: object) =>
  call('POST', `/challenges/${id}/answer`, token, payload);

async function connectorRow(id: string) {
  const [row] = await database.db.select().from(connectors).where(eq(connectors.id, id));
  if (!row) throw new Error('connector not found');
  return row;
}

describe('connect', () => {
  it('decoupled: polls respect pollAfterMs, completes, discovers accounts and syncs', async () => {
    const res = await connect(bToken, { scenario: 'decoupled', pendingPolls: 1 });
    expect(res.status).toBe(200);
    const { connectorId, challenge } = res.json;
    expect(challenge).toMatchObject({ kind: 'decoupled', pollAfterMs: 1000 });
    expect((await connectorRow(connectorId)).status).toBe('needs_attention');
    expect(Date.parse(challenge.expiresAt)).toBe(T0 + 10 * 60 * 1000);

    // the first poll is throttled from challenge creation, too
    expect((await answer(bToken, challenge.id, { kind: 'decoupled' })).status).toBe(429);
    nowMs += 1500;
    const first = await answer(bToken, challenge.id, { kind: 'decoupled' });
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ status: 'open', challenge: { kind: 'decoupled' } });

    const tooEarly = await answer(bToken, challenge.id, { kind: 'decoupled' });
    expect(tooEarly.status).toBe(429);
    expect(Number(tooEarly.headers['retry-after'])).toBeGreaterThan(0);

    expect((await call('GET', `/challenges/${challenge.id}`, bToken)).json).toEqual({
      status: 'open',
    });

    nowMs += 1500;
    const done = await answer(bToken, challenge.id, { kind: 'decoupled' });
    expect(done.json).toEqual({ status: 'completed' });

    const row = await connectorRow(connectorId);
    expect(row.status).toBe('ok');
    expect(row.stateEnc).not.toBeNull();
    const accs = await database.db
      .select()
      .from(accounts)
      .where(eq(accounts.connectorId, connectorId));
    expect(accs).toHaveLength(1);
    expect(accs[0]).toMatchObject({ visibility: 'household', countsTowardBudgets: true });
    await app.ctx.sync.idle();
    const runs = await database.db
      .select()
      .from(syncRuns)
      .where(eq(syncRuns.connectorId, connectorId));
    expect(runs.map((r) => r.trigger)).toEqual(['user']);
  });

  it('does not call the bank on a too-early decoupled poll, and GET never calls the bank', async () => {
    const res = await connect(bToken, { scenario: 'decoupled', pendingPolls: 2 }, 'spy');
    const id = res.json.challenge.id;
    nowMs += 1500;
    await answer(bToken, id, { kind: 'decoupled' });
    expect(continueCalls).toBe(1);
    expect((await answer(bToken, id, { kind: 'decoupled' })).status).toBe(429);
    await call('GET', `/challenges/${id}`, bToken);
    expect(continueCalls).toBe(1);
  });

  it('happy scenario completes without a challenge', async () => {
    const res = await connect(bToken, { scenario: 'happy' });
    expect(res.status).toBe(200);
    expect(res.json.challenge).toBeUndefined();
    expect((await connectorRow(res.json.connectorId)).status).toBe('ok');
    await app.ctx.sync.idle();
  });

  it('code: wrong code keeps the challenge, right code completes', async () => {
    const res = await connect(bToken, { scenario: 'code' });
    const id = res.json.challenge.id;
    const wrong = await answer(bToken, id, { kind: 'code', code: '000000' });
    expect(wrong.json).toMatchObject({ status: 'open', challenge: { kind: 'code', id } });
    const right = await answer(bToken, id, { kind: 'code', code: '123456' });
    expect(right.json).toEqual({ status: 'completed' });
    expect((await connectorRow(res.json.connectorId)).status).toBe('ok');
    await app.ctx.sync.idle();
  });

  it('too many wrong codes at the bank cancels the challenge, connector stays needs_attention', async () => {
    const res = await connect(bToken, { scenario: 'code' });
    const id = res.json.challenge.id;
    let last: Res | undefined;
    for (let i = 0; i < 3; i++) last = await answer(bToken, id, { kind: 'code', code: '000000' });
    expect(last?.status).toBe(200);
    expect(last?.json).toEqual({ status: 'cancelled', reason: 'too_many_attempts' });
    expect((await connectorRow(res.json.connectorId)).status).toBe('needs_attention');
    expect((await call('GET', `/challenges/${id}`, bToken)).json).toEqual({ status: 'cancelled' });
  });

  it('redirect: callback completes; a bad callback is 422 and keeps the challenge open', async () => {
    const res = await connect(bToken, { scenario: 'redirect' });
    const { id, url } = res.json.challenge;
    const state = new URL(url).searchParams.get('state');
    const bad = await answer(bToken, id, {
      kind: 'redirect',
      callbackUrl: 'budgedino://cb?code=no',
    });
    expect(bad.status).toBe(422);
    expect(bad.json['error']).toBe('invalid_answer');
    expect((await call('GET', `/challenges/${id}`, bToken)).json).toEqual({ status: 'open' });
    const ok = await answer(bToken, id, {
      kind: 'redirect',
      callbackUrl: `budgedino://cb?code=ok&state=${state}`,
    });
    expect(ok.json).toEqual({ status: 'completed' });
    await app.ctx.sync.idle();
  });

  it('the 5th invalid answer cancels the challenge and calls cancelAuth', async () => {
    const res = await connect(bToken, { scenario: 'redirect' }, 'spy');
    const id = res.json.challenge.id;
    const bad = { kind: 'redirect', callbackUrl: 'budgedino://cb?code=no' };
    for (let i = 0; i < 4; i++) expect((await answer(bToken, id, bad)).status).toBe(422);
    const fifth = await answer(bToken, id, bad);
    expect(fifth.status).toBe(200);
    expect(fifth.json).toEqual({ status: 'cancelled', reason: 'too_many_invalid_answers' });
    expect(cancelCalls).toBe(1);
    expect((await connectorRow(res.json.connectorId)).status).toBe('needs_attention');
  });

  it('rejects unknown connector types and invalid configs with 400', async () => {
    expect((await connect(bToken, { scenario: 'happy' }, 'nope')).status).toBe(400);
    expect((await connect(bToken, { scenario: 'bogus' })).status).toBe(400);
    expect((await call('POST', '/connectors', bToken, { type: 'fake' })).status).toBe(400);
    expect(await database.db.select().from(connectors)).toHaveLength(0);
  });

  it('stores config encrypted', async () => {
    const res = await connect(bToken, { scenario: 'code', accountRef: MARKER });
    const row = await connectorRow(res.json.connectorId);
    expect(row.configEnc.toString('latin1')).not.toContain(MARKER);
  });
});

describe('challenge lifecycle', () => {
  it('abandoned challenge expires after the TTL; reconnect gives a fresh challenge and completes', async () => {
    const res = await connect(bToken, { scenario: 'code' });
    const { connectorId } = res.json;
    const oldId = res.json.challenge.id;
    nowMs += 10 * 60 * 1000 + 1000;
    expect((await call('GET', `/challenges/${oldId}`, bToken)).json).toEqual({ status: 'expired' });
    expect((await connectorRow(connectorId)).status).toBe('needs_attention');
    const late = await answer(bToken, oldId, { kind: 'code', code: '123456' });
    expect(late.json).toEqual({ status: 'expired' });

    const re = await call('POST', `/connectors/${connectorId}/reconnect`, bToken);
    expect(re.status).toBe(200);
    expect(re.json.challenge.id).not.toBe(oldId);
    const done = await answer(bToken, re.json.challenge.id, { kind: 'code', code: '123456' });
    expect(done.json).toEqual({ status: 'completed' });
    expect((await connectorRow(connectorId)).status).toBe('ok');
    await app.ctx.sync.idle();
  });

  it('the sweeper expires open and stale answering challenges and calls cancelAuth', async () => {
    const a = await connect(bToken, { scenario: 'code' }, 'spy');
    const b = await connect(bToken, { scenario: 'code' }, 'spy');
    await database.db
      .update(challenges)
      .set({ status: 'answering' })
      .where(eq(challenges.id, b.json.challenge.id));
    const deps = {
      db: database.db,
      keyring,
      registry: app.ctx.registry,
      logger: createLogger({ level: 'silent' }),
      now: () => new Date(nowMs),
    };
    expect(await expireChallenges(deps)).toBe(0);
    nowMs += 11 * 60 * 1000;
    // the open one is due; the answering one gets a 2 minute grace
    expect(await expireChallenges(deps)).toBe(1);
    nowMs += 2 * 60 * 1000;
    expect(await expireChallenges(deps)).toBe(1);
    expect(cancelCalls).toBe(2);
    for (const r of [a, b]) {
      expect((await call('GET', `/challenges/${r.json.challenge.id}`, bToken)).json).toEqual({
        status: 'expired',
      });
      expect((await connectorRow(r.json.connectorId)).status).toBe('needs_attention');
    }
  });

  it('a reconnect cancels the previous open challenge (cancelAuth called)', async () => {
    const res = await connect(bToken, { scenario: 'code' }, 'spy');
    const oldId = res.json.challenge.id;
    const re = await call('POST', `/connectors/${res.json.connectorId}/reconnect`, bToken);
    expect(re.status).toBe(200);
    expect(cancelCalls).toBe(1);
    expect((await call('GET', `/challenges/${oldId}`, bToken)).json).toEqual({
      status: 'cancelled',
    });
    const open = await database.db.select().from(challenges).where(eq(challenges.status, 'open'));
    expect(open).toHaveLength(1);
  });

  it('DELETE cancels the challenge and calls cancelAuth', async () => {
    const res = await connect(bToken, { scenario: 'code' }, 'spy');
    const id = res.json.challenge.id;
    const del = await call('DELETE', `/challenges/${id}`, bToken);
    expect(del.status).toBe(200);
    expect(del.json).toEqual({ status: 'cancelled' });
    expect(cancelCalls).toBe(1);
    const after = await answer(bToken, id, { kind: 'code', code: '123456' });
    expect(after.json).toEqual({ status: 'cancelled' });
  });

  it('two simultaneous answers call continueAuth once', async () => {
    const res = await connect(bToken, { scenario: 'code' }, 'spy');
    const id = res.json.challenge.id;
    continueDelayMs = 200;
    const go = () => answer(bToken, id, { kind: 'code', code: '123456' });
    const [x, y] = await Promise.all([go(), go()]);
    expect(continueCalls).toBe(1);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    await app.ctx.sync.idle();
  });

  it('reconnect after done does not duplicate accounts; a throttled sync does not fail it', async () => {
    const res = await connect(bToken, { scenario: 'happy' });
    const { connectorId } = res.json;
    const re = await call('POST', `/connectors/${connectorId}/reconnect`, bToken);
    expect(re.status).toBe(200); // the user sync from connect throttles this one
    await app.ctx.sync.idle();
    const accs = await database.db
      .select()
      .from(accounts)
      .where(eq(accounts.connectorId, connectorId));
    expect(accs).toHaveLength(1);
  });
});

describe('access', () => {
  it('another member cannot answer, read, cancel or reconnect (404)', async () => {
    const res = await connect(bToken, { scenario: 'code' }, 'spy');
    const id = res.json.challenge.id;
    const foreign = await answer(aToken, id, { kind: 'code', code: '123456' });
    expect(foreign.status).toBe(404);
    expect((await call('GET', `/challenges/${id}`, aToken)).status).toBe(404);
    expect((await call('DELETE', `/challenges/${id}`, aToken)).status).toBe(404);
    expect(
      (await call('POST', `/connectors/${res.json.connectorId}/reconnect`, aToken)).status,
    ).toBe(404);
    expect(continueCalls).toBe(0);
    expect(cancelCalls).toBe(0);
    const ok = await answer(bToken, id, { kind: 'code', code: '123456' });
    expect(ok.json).toEqual({ status: 'completed' });
    await app.ctx.sync.idle();
  });

  it('requires authentication', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/connectors', payload: {} });
    expect(res.statusCode).toBe(401);
  });
});

describe('dialog state', () => {
  it('never appears in a response and is stored encrypted', async () => {
    const res = await connect(bToken, { scenario: 'code', accountRef: MARKER });
    const id = res.json.challenge.id;
    const bodies = [res.body];
    bodies.push((await call('GET', `/challenges/${id}`, bToken)).body);
    bodies.push((await answer(bToken, id, { kind: 'code', code: '000000' })).body);
    bodies.push((await call('POST', `/connectors/${res.json.connectorId}/reconnect`, bToken)).body);
    bodies.push((await call('GET', '/connectors', bToken)).body);
    for (const b of bodies) {
      expect(b).not.toContain(MARKER);
      expect(b).not.toContain('"dialog"');
    }
    const rows = await database.db.select().from(challenges);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.payloadEnc.toString('latin1')).not.toContain(MARKER);
  });
});

describe('failed connect', () => {
  it('removes the new connector when startAuth fails, so a retry creates exactly one', async () => {
    startMode = 'fail';
    const failed = await connect(bToken, { scenario: 'code' }, 'flaky-start');
    expect(failed.status).toBe(502);
    expect(await database.db.select().from(connectors)).toHaveLength(0);
    startMode = 'refuse';
    expect((await connect(bToken, { scenario: 'code' }, 'flaky-start')).status).toBe(409);
    expect(await database.db.select().from(connectors)).toHaveLength(0);
    startMode = 'ok';
    const ok = await connect(bToken, { scenario: 'code' }, 'flaky-start');
    expect(ok.status).toBe(200);
    expect(await database.db.select().from(connectors)).toHaveLength(1);
  });

  it('keeps an existing connector when a reconnect fails', async () => {
    const res = await connect(bToken, { scenario: 'code' }, 'flaky-start');
    startMode = 'fail';
    const re = await call('POST', `/connectors/${res.json.connectorId}/reconnect`, bToken);
    expect(re.status).toBe(502);
    expect(await database.db.select().from(connectors)).toHaveLength(1);
  });
});

describe('lifetime and sweeper hardening', () => {
  it('renewals never stretch a challenge beyond 15 minutes', async () => {
    const res = await connect(bToken, { scenario: 'decoupled', pendingPolls: 50 });
    const id = res.json.challenge.id;
    nowMs += 9 * 60 * 1000;
    const polled = await answer(bToken, id, { kind: 'decoupled' });
    expect(polled.json.status).toBe('open');
    expect(Date.parse(polled.json.challenge.expiresAt)).toBe(T0 + 15 * 60 * 1000);
    nowMs += 7 * 60 * 1000;
    expect((await call('GET', `/challenges/${id}`, bToken)).json).toEqual({ status: 'expired' });
  });

  it('cancelAuth is user-present for user actions and not for the sweeper', async () => {
    const a = await connect(bToken, { scenario: 'code' }, 'spy');
    await call('DELETE', `/challenges/${a.json.challenge.id}`, bToken);
    await connect(bToken, { scenario: 'code' }, 'spy');
    nowMs += 11 * 60 * 1000;
    await expireChallenges({
      db: database.db,
      keyring,
      registry: app.ctx.registry,
      logger: createLogger({ level: 'silent' }),
      now: () => new Date(nowMs),
    });
    expect(cancelUserPresent).toEqual([true, false]);
  });
});

describe('serialised with sync', () => {
  async function startBlockedSync() {
    let release!: () => void;
    fetchGate = new Promise<void>((r) => (release = r));
    const res = await connect(bToken, { scenario: 'happy' }, 'spy');
    await vi.waitFor(async () => {
      expect(await database.db.select().from(syncRuns)).toHaveLength(1);
    });
    return { connectorId: res.json.connectorId as string, release };
  }
  const stateOf = async (connectorId: string) => {
    const row = await connectorRow(connectorId);
    const dk = await keyring.forHousehold(row.householdId);
    return { row, state: decryptConnectorState(dk, connectorId, row.stateEnc) };
  };

  it('a reconnect completing mid-sync returns at once and keeps the new state and status ok', async () => {
    const { connectorId, release } = await startBlockedSync();
    // the sync is blocked in its bank call and holds the connector lock; the reconnect must not wait for it
    const reconnect = await call('POST', `/connectors/${connectorId}/reconnect`, bToken);
    expect(reconnect.status).toBe(200);
    release();
    await app.ctx.sync.idle();
    const { row } = await stateOf(connectorId);
    expect(row.status).toBe('ok');
    expect(row.stateGeneration).toBe(2);
    // superseded: wrote neither state nor status; the post-connect request that had coalesced onto it
    // gets a fresh run with the new authentication
    const runs = await database.db.select().from(syncRuns).orderBy(syncRuns.startedAt, syncRuns.id);
    expect(runs.map((r) => r.outcome)).toEqual(['skipped', 'ok']);
    expect(runs.map((r) => r.connectorGeneration)).toEqual([1, 2]);
    expect(runs[1]?.trigger).toBe('user');
  });

  it('a superseded run that hit needs_attention does not notify; the follow-up run decides', async () => {
    let release!: () => void;
    fetchGate = new Promise<void>((r) => (release = r));
    const res = await connect(bToken, { scenario: 'expired-consent' }, 'spy');
    await vi.waitFor(async () => {
      expect(await database.db.select().from(syncRuns)).toHaveLength(1);
    });
    await call('POST', `/connectors/${res.json.connectorId}/reconnect`, bToken);
    release();
    await app.ctx.sync.idle();
    const runs = await database.db.select().from(syncRuns).orderBy(syncRuns.startedAt, syncRuns.id);
    expect(runs.map((r) => r.outcome)).toEqual(['skipped', 'needs_attention']);
    // only the follow-up (current generation) notified, not the superseded run
    expect(await database.db.select().from(notifications)).toHaveLength(1);
  });

  it('a superseded run that errors neither sets status error nor notifies', async () => {
    const { connectorId, release } = await startBlockedSync();
    fetchThrows = true;
    await call('POST', `/connectors/${connectorId}/reconnect`, bToken);
    release();
    await app.ctx.sync.idle();
    const after = await connectorRow(connectorId);
    expect(after.status).toBe('ok');
    expect(after.lastErrorCode).toBeNull();
    expect(await database.db.select().from(notifications)).toHaveLength(0);
    const [run] = await database.db.select().from(syncRuns);
    expect(run?.outcome).toBe('error');
  });

  it('a reconnect resets the error streak: two old errors plus one new do not flip to error', async () => {
    const res = await connect(bToken, { scenario: 'happy' }, 'spy');
    const { connectorId } = res.json;
    await app.ctx.sync.idle();
    const old = [1, 2].map((n) => ({
      connectorId,
      trigger: 'schedule' as const,
      startedAt: new Date(Date.now() + n * 1000),
      finishedAt: new Date(),
      outcome: 'error',
      errorCode: 'sync_failed',
      connectorGeneration: 0, // before the authentication
    }));
    await database.db.insert(syncRuns).values(old);
    fetchThrows = true;
    const deps = {
      db: database.db,
      keyring,
      registry: app.ctx.registry,
      logger: createLogger({ level: 'silent' }),
      now: () => new Date(Date.now() + 60_000),
      onIngested: async () => {},
    };
    const result = await runSync(deps, connectorId, 'user');
    expect(result.outcome).toBe('error');
    expect((await connectorRow(connectorId)).status).toBe('ok');
    expect(await database.db.select().from(notifications)).toHaveLength(0);
  });

  it('a run whose connector was re-authenticated does not write state or status', async () => {
    const { connectorId, release } = await startBlockedSync();
    const row = await connectorRow(connectorId);
    const dk = await keyring.forHousehold(row.householdId);
    await database.db
      .update(connectors)
      .set({
        status: 'needs_attention',
        stateGeneration: 5,
        stateEnc: encryptConnectorState(dk, connectorId, { scenario: 'happy', fresh: true }),
      })
      .where(eq(connectors.id, connectorId));
    release();
    await app.ctx.sync.idle();
    const after = await stateOf(connectorId);
    expect(after.state['fresh']).toBe(true);
    expect(after.row.status).toBe('needs_attention');
    const [run] = await database.db.select().from(syncRuns);
    expect(run?.outcome).toBe('skipped');
  });
});

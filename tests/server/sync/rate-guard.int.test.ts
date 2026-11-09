import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeConnector } from '@budgedino/server/connectors/fake/fake-connector';
import { createConnectorRegistry } from '@budgedino/server/connectors/registry';
import { decryptString } from '@budgedino/server/crypto';
import { createAccount } from '@budgedino/server/repositories/accounts';
import { decryptConnectorState } from '@budgedino/server/repositories/connectors';
import { connectors, notifications, syncRuns } from '@budgedino/server/db/schema';
import { Keyring } from '@budgedino/server/households/keyring';
import { createLogger } from '@budgedino/server/observability/logger';
import { runSync, type SyncDeps } from '@budgedino/server/sync/run';
import { createHousehold, createTestMember, randomMasterKey } from '../../support/factories.js';
import { startTestDatabase, type TestDatabase } from '../../support/postgres.js';
import { seedFakeConnector } from '../../support/sync.js';

let database: TestDatabase;
let keyring: Keyring;
let householdId: string;
let ownerId: string;
let otherId: string;
let nowMs: number;
const onIngested = vi.fn(async () => {});

beforeAll(async () => {
  database = await startTestDatabase();
}, 120_000);
afterAll(async () => database.stop());

beforeEach(async () => {
  await database.reset();
  onIngested.mockClear();
  nowMs = Date.UTC(2026, 10, 9, 12, 0, 0);
  keyring = new Keyring(database.db, randomMasterKey());
  householdId = await createHousehold(database.db, keyring);
  ownerId = await createTestMember(database.db, keyring, householdId, { role: 'member' });
  otherId = await createTestMember(database.db, keyring, householdId, { role: 'admin' });
});

const registry = createConnectorRegistry([
  createFakeConnector({ rateLimit: { maxUnattendedPerDay: 4 } }),
]);
const deps = (): SyncDeps => ({
  db: database.db,
  keyring,
  registry,
  logger: createLogger({ level: 'silent' }),
  now: () => new Date(nowMs),
  onIngested,
});

describe('rate guard', () => {
  it('skips the 5th unattended run within 24h; user runs still execute and are not counted', async () => {
    const { connectorId } = await seedFakeConnector(database.db, keyring, householdId, ownerId);
    const outcomes: (string | null)[] = [];
    for (let i = 0; i < 5; i++) {
      nowMs += 60_000;
      outcomes.push((await runSync(deps(), connectorId, 'schedule')).outcome);
    }
    expect(outcomes).toEqual(['ok', 'ok', 'ok', 'ok', 'rate_limited']);

    const user = await runSync(deps(), connectorId, 'user', { psuIp: '203.0.113.7' });
    expect(user.outcome).toBe('ok');
    nowMs += 60_000;
    expect((await runSync(deps(), connectorId, 'schedule')).outcome).toBe('rate_limited');
  });

  it('frees the budget when runs leave the rolling 24h window', async () => {
    const { connectorId } = await seedFakeConnector(database.db, keyring, householdId, ownerId);
    for (let i = 0; i < 4; i++) await runSync(deps(), connectorId, 'schedule');
    expect((await runSync(deps(), connectorId, 'schedule')).outcome).toBe('rate_limited');
    nowMs += 24 * 3600_000 + 1000;
    expect((await runSync(deps(), connectorId, 'schedule')).outcome).toBe('ok');
  });

  it('passes userPresent and psuIp to the connector only for user runs', async () => {
    const { connectorId } = await seedFakeConnector(database.db, keyring, householdId, ownerId);
    const spy = vi.spyOn(registry.get('fake'), 'fetchTransactions');
    spy.mockClear();
    await runSync(deps(), connectorId, 'user', { psuIp: '203.0.113.7' });
    await runSync(deps(), connectorId, 'schedule');
    const ctxs = spy.mock.calls.map((c) => c[3]);
    expect(ctxs[0]).toMatchObject({ userPresent: true, psuIp: '203.0.113.7' });
    expect(ctxs[1]).toMatchObject({ userPresent: false });
    expect(ctxs[1]?.psuIp).toBeUndefined();
    const runs = await database.db.select().from(syncRuns);
    expect(runs.map((r) => `${r.trigger}:${String(r.userPresent)}`).sort()).toEqual([
      'schedule:false',
      'user:true',
    ]);
    spy.mockRestore();
  });
});

describe('needs_attention', () => {
  it('sets the connector status and notifies only the owner, once, without sensitive content', async () => {
    const { connectorId } = await seedFakeConnector(database.db, keyring, householdId, ownerId, {
      scenario: 'expired-consent',
    });
    const first = await runSync(deps(), connectorId, 'schedule');
    expect(first.outcome).toBe('needs_attention');
    const [c] = await database.db.select().from(connectors).where(eq(connectors.id, connectorId));
    expect(c?.status).toBe('needs_attention');
    expect(c?.lastErrorCode).toBe('needs_attention');

    // a later user run that fails again must not create a second notification
    await runSync(deps(), connectorId, 'user');
    const rows = await database.db.select().from(notifications);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (!row?.bodyEnc) throw new Error('missing notification');
    expect(row).toMatchObject({ kind: 'connector_attention', memberId: ownerId, householdId });
    expect(row.memberId).not.toBe(otherId);
    const dk = await keyring.forHousehold(householdId);
    const body = decryptString(dk, row.bodyEnc, {
      table: 'notifications',
      column: 'body',
      rowId: row.id,
    });
    expect(body).toContain('fake');
    expect(body).not.toMatch(/\d+[.,]\d{2}|DE\d{2}/);
  });

  it('does not run scheduled syncs for connectors that need attention', async () => {
    const { connectorId } = await seedFakeConnector(database.db, keyring, householdId, ownerId, {
      scenario: 'expired-consent',
    });
    await runSync(deps(), connectorId, 'schedule');
    const second = await runSync(deps(), connectorId, 'schedule');
    expect(second.outcome).toBe('skipped');
  });
});

describe('errors and serialisation', () => {
  it('records unexpected connector exceptions as a stable code, never the message', async () => {
    const { connectorId } = await seedFakeConnector(database.db, keyring, householdId, ownerId);
    const spy = vi
      .spyOn(registry.get('fake'), 'fetchTransactions')
      .mockRejectedValue(new Error('boom DE89370400440532013000'));
    const res = await runSync(deps(), connectorId, 'schedule');
    spy.mockRestore();
    expect(res.outcome).toBe('error');
    const [c] = await database.db.select().from(connectors).where(eq(connectors.id, connectorId));
    expect(c?.lastErrorCode).toBe('sync_failed');
    const [run] = await database.db.select().from(syncRuns).where(eq(syncRuns.id, res.runId));
    expect(run).toMatchObject({ outcome: 'error', errorCode: 'sync_failed' });
    expect(run?.finishedAt).not.toBeNull();
  });

  it('persists the state of a failed fetch and serialises concurrent runs', async () => {
    const { connectorId } = await seedFakeConnector(database.db, keyring, householdId, ownerId, {
      scenario: 'flaky',
    });
    const results = await Promise.all([
      runSync(deps(), connectorId, 'user'),
      runSync(deps(), connectorId, 'user'),
    ]);
    // flaky: the first fetch of a state fails temporarily and carries fetchCount 1. Because that state
    // is persisted before the second (serialised) run starts, the second run succeeds.
    expect(results.map((r) => r.outcome).sort()).toEqual(['ok', 'temporary']);
  });
});

describe('durable state, account refs, error streak', () => {
  it('keeps the state returned for account 1 when the fetch of account 2 throws', async () => {
    const { connectorId } = await seedFakeConnector(database.db, keyring, householdId, ownerId);
    const dk = await keyring.forHousehold(householdId);
    await createAccount(database.db, dk, {
      connectorId,
      ownerMemberId: ownerId,
      externalRef: 'fake-2',
      name: 'Second',
      kind: 'checking',
      currency: 'EUR',
    });
    const fake = registry.get('fake');
    const spy = vi
      .spyOn(fake, 'fetchTransactions')
      .mockResolvedValueOnce({
        ok: true,
        transactions: [],
        state: { scenario: 'happy', accountRef: 'fake-1', transactions: [], rotated: 'token-2' },
      })
      .mockRejectedValueOnce(new Error('network down'));
    const res = await runSync(deps(), connectorId, 'user');
    spy.mockRestore();
    expect(res.outcome).toBe('error');
    const [c] = await database.db.select().from(connectors).where(eq(connectors.id, connectorId));
    const state = decryptConnectorState(dk, connectorId, c?.stateEnc ?? null);
    expect(state['rotated']).toBe('token-2');
  });

  it('never calls listAccounts during a run (uses the stored bank reference)', async () => {
    const { connectorId } = await seedFakeConnector(database.db, keyring, householdId, ownerId);
    const spy = vi.spyOn(registry.get('fake'), 'listAccounts');
    spy.mockClear();
    const fetchSpy = vi.spyOn(registry.get('fake'), 'fetchTransactions');
    fetchSpy.mockClear();
    await runSync(deps(), connectorId, 'user');
    expect(spy).not.toHaveBeenCalled();
    expect(fetchSpy.mock.calls[0]?.[1]).toBe('fake-1');
    spy.mockRestore();
    fetchSpy.mockRestore();
  });

  it('after 3 consecutive error runs sets status=error, notifies the owner once and stops scheduling', async () => {
    const { connectorId } = await seedFakeConnector(database.db, keyring, householdId, ownerId);
    const spy = vi
      .spyOn(registry.get('fake'), 'fetchTransactions')
      .mockRejectedValue(new Error('boom'));
    for (let i = 0; i < 2; i++) {
      nowMs += 60_000;
      await runSync(deps(), connectorId, 'user');
    }
    let [c] = await database.db.select().from(connectors).where(eq(connectors.id, connectorId));
    expect(c?.status).toBe('ok');
    expect(await database.db.select().from(notifications)).toHaveLength(0);
    nowMs += 60_000;
    await runSync(deps(), connectorId, 'user');
    nowMs += 60_000;
    await runSync(deps(), connectorId, 'user'); // 4th: already in error, no second notification
    spy.mockRestore();
    [c] = await database.db.select().from(connectors).where(eq(connectors.id, connectorId));
    expect(c?.status).toBe('error');
    const rows = await database.db.select().from(notifications);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'connector_attention', memberId: ownerId });
    expect((await runSync(deps(), connectorId, 'schedule')).outcome).toBe('skipped');
    // a successful user run recovers the connector
    nowMs += 60_000;
    expect((await runSync(deps(), connectorId, 'user')).outcome).toBe('ok');
    [c] = await database.db.select().from(connectors).where(eq(connectors.id, connectorId));
    expect(c?.status).toBe('ok');
  });
});

describe('concurrency cap', () => {
  it('runs more concurrent syncs (different connectors) than the cap without exceeding it', async () => {
    const connectorIds: string[] = [];
    for (let i = 0; i < 8; i++) {
      const { connectorId } = await seedFakeConnector(database.db, keyring, householdId, ownerId, {
        accountRef: `ref-${i}`,
      });
      connectorIds.push(connectorId);
    }
    let held = 0;
    let peak = 0;
    const d: SyncDeps = {
      ...deps(),
      onLockHeld: (event) => {
        held += event === 'acquired' ? 1 : -1;
        peak = Math.max(peak, held);
      },
    };
    const fake = registry.get('fake');
    const spy = vi.spyOn(fake, 'fetchTransactions').mockImplementation(async (state) => {
      await new Promise((r) => setTimeout(r, 50));
      return { ok: true, transactions: [], state };
    });
    const results = await Promise.all(connectorIds.map((id) => runSync(d, id, 'user')));
    spy.mockRestore();
    expect(results.map((r) => r.outcome)).toEqual(connectorIds.map(() => 'ok'));
    expect(peak).toBeGreaterThanOrEqual(1);
    expect(peak).toBeLessThanOrEqual(2);
    expect(held).toBe(0);
  });
});

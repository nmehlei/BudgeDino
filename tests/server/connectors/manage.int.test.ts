import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '@budgedino/server/app';
import { visibleAccountIds } from '@budgedino/server/access/visibility';
import { backfillConnectorBanks } from '@budgedino/server/connectors/bank-backfill';
import { createFakeConnector } from '@budgedino/server/connectors/fake/fake-connector';
import { createConnectorRegistry } from '@budgedino/server/connectors/registry';
import type { Connector } from '@budgedino/server/connectors/types';
import { encryptField } from '@budgedino/server/crypto';
import { newId } from '@budgedino/server/db/ids';
import {
  accounts,
  challenges,
  connectors,
  syncRuns,
  transactionSplits,
  transactions,
} from '@budgedino/server/db/schema';
import { Keyring } from '@budgedino/server/households/keyring';
import { createLogger } from '@budgedino/server/observability/logger';
import { createTransaction } from '@budgedino/server/repositories/transactions';
import {
  createHousehold,
  createTestChallenge,
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
/** While set, the fake connector blocks inside its bank call. */
let fetchGate: Promise<void> | null;
let signalEntered: () => void;
let entered: Promise<void>;

beforeAll(async () => {
  database = await startTestDatabase();
}, 120_000);
afterAll(async () => {
  await app?.close();
  await database.stop();
});

function gatedFake(): Connector {
  const fake = createFakeConnector();
  return {
    ...fake,
    async fetchTransactions(...args) {
      signalEntered();
      if (fetchGate) await fetchGate;
      return fake.fetchTransactions(...args);
    },
  };
}

beforeEach(async () => {
  await app?.close();
  await database.reset();
  fetchGate = null;
  entered = new Promise<void>((resolve) => (signalEntered = resolve));
  const master = randomMasterKey();
  keyring = new Keyring(database.db, master);
  app = buildApp({
    db: database.db,
    keyring,
    master,
    registry: createConnectorRegistry([gatedFake()]),
    logger: createLogger({ level: 'silent' }),
  });
  await app.ready();
  householdId = await createHousehold(database.db, keyring);
  aId = await createTestMember(database.db, keyring, householdId, { role: 'admin' });
  bId = await createTestMember(database.db, keyring, householdId, { role: 'member' });
  aToken = await createTestSession(database.db, keyring, householdId, aId);
  bToken = await createTestSession(database.db, keyring, householdId, bId);
});

const call = (
  method: 'GET' | 'POST' | 'DELETE' | 'PATCH',
  url: string,
  token: string,
  payload?: object,
) =>
  app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { authorization: `Bearer ${token}` },
    ...(payload ? { payload } : {}),
  });

/** B's connector with one account, two transactions (one with a split) and an open challenge. */
async function seedConnectorWithData() {
  const { connectorId, accountId } = await seedFakeConnector(
    database.db,
    keyring,
    householdId,
    bId,
  );
  const dk = await keyring.forHousehold(householdId);
  const txIds: string[] = [];
  for (const n of [1, 2]) {
    txIds.push(
      await createTransaction(database.db, dk, {
        accountId,
        dedupKey: `tx-${n}`,
        status: 'booked',
        bookingDate: '2026-11-01',
        amountMinor: -100n * BigInt(n),
        currency: 'EUR',
        counterparty: 'Shop',
      }),
    );
  }
  await database.db.insert(transactionSplits).values({
    transactionId: txIds[0] as string,
    amountEnc: encryptField(dk, '-100', {
      table: 'transaction_splits',
      column: 'amount',
      rowId: newId(),
    }),
  });
  const challengeId = await createTestChallenge(
    database.db,
    keyring,
    householdId,
    connectorId,
    bId,
  );
  return { connectorId, accountId, txIds, challengeId };
}

const counts = async () => ({
  connectors: (await database.db.select().from(connectors)).length,
  accounts: (await database.db.select().from(accounts)).length,
  transactions: (await database.db.select().from(transactions)).length,
  splits: (await database.db.select().from(transactionSplits)).length,
  challenges: (await database.db.select().from(challenges)).length,
});

describe('DELETE /connectors/:id', () => {
  it('requires a valid mode', async () => {
    const { connectorId } = await seedConnectorWithData();
    expect((await call('DELETE', `/connectors/${connectorId}`, bToken)).statusCode).toBe(400);
    expect((await call('DELETE', `/connectors/${connectorId}?mode=x`, bToken)).statusCode).toBe(
      400,
    );
    expect((await counts()).connectors).toBe(1);
  });

  it('returns 404 for another member (admin included) and unknown ids, and changes nothing', async () => {
    const { connectorId } = await seedConnectorWithData();
    const before = await counts();
    for (const mode of ['keep', 'purge']) {
      const other = await call('DELETE', `/connectors/${connectorId}?mode=${mode}`, aToken);
      expect(other.statusCode).toBe(404);
    }
    const missing = await call('DELETE', `/connectors/${newId()}?mode=purge`, bToken);
    expect(missing.statusCode).toBe(404);
    expect(await counts()).toEqual(before);
    expect(
      (await app.inject({ method: 'DELETE', url: `/api/v1/connectors/${connectorId}?mode=keep` }))
        .statusCode,
    ).toBe(401);
  });

  it('keep: removes connector, state and challenges; accounts and transactions stay, disconnected', async () => {
    const { connectorId, accountId } = await seedConnectorWithData();
    const res = await call('DELETE', `/connectors/${connectorId}?mode=keep`, bToken);
    expect(res.statusCode).toBe(204);
    expect(await counts()).toEqual({
      connectors: 0,
      accounts: 1,
      transactions: 2,
      splits: 1,
      challenges: 0,
    });
    const [account] = await database.db.select().from(accounts).where(eq(accounts.id, accountId));
    expect(account?.connectorId).toBeNull();
    expect(account?.disconnectedAt).toBeInstanceOf(Date);
    expect(account?.countsTowardBudgets).toBe(true);
    // still visible to the household and its owner; the API says it is disconnected
    const ids = await visibleAccountIds(database.db, { memberId: aId, householdId });
    expect([...ids]).toEqual([accountId]);
    const list = (await call('GET', '/accounts', aToken)).json<{
      accounts: { id: string; connectorId: string | null; disconnected: boolean }[];
    }>();
    expect(list.accounts).toMatchObject([{ id: accountId, connectorId: null, disconnected: true }]);
    const connectorsList = (await call('GET', '/connectors', bToken)).json<{
      connectors: unknown[];
    }>();
    expect(connectorsList.connectors).toEqual([]);
  });

  it('purge: also deletes accounts, transactions, splits and balances', async () => {
    const { connectorId } = await seedConnectorWithData();
    const res = await call('DELETE', `/connectors/${connectorId}?mode=purge`, bToken);
    expect(res.statusCode).toBe(204);
    expect(await counts()).toEqual({
      connectors: 0,
      accounts: 0,
      transactions: 0,
      splits: 0,
      challenges: 0,
    });
  });

  it('only touches the removed connector', async () => {
    const first = await seedConnectorWithData();
    const other = await seedFakeConnector(database.db, keyring, householdId, bId, {
      accountRef: 'fake-2',
    });
    await call('DELETE', `/connectors/${first.connectorId}?mode=purge`, bToken);
    const rows = await database.db.select().from(accounts);
    expect(rows.map((r) => r.id)).toEqual([other.accountId]);
  });

  it('waits for a running sync (purge): nothing is written afterwards and nothing is left behind', async () => {
    const { connectorId } = await seedConnectorWithData();
    let release!: () => void;
    fetchGate = new Promise<void>((resolve) => (release = resolve));
    const sync = await call('POST', `/connectors/${connectorId}/sync`, bToken);
    expect(sync.statusCode).toBe(202);
    await entered; // the run holds the connector lock and is inside the bank call

    let finished = false;
    const del = call('DELETE', `/connectors/${connectorId}?mode=purge`, bToken).then((r) => {
      finished = true;
      return r;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(finished).toBe(false); // blocked behind the sync's lock
    expect((await counts()).accounts).toBe(1);

    release();
    expect((await del).statusCode).toBe(204);
    await app.ctx.sync.idle();
    expect(await counts()).toEqual({
      connectors: 0,
      accounts: 0,
      transactions: 0,
      splits: 0,
      challenges: 0,
    });
    expect(await database.db.select().from(syncRuns)).toEqual([]);
  });

  it('keep during a sync: the run completes first, its data stays attached to the disconnected account', async () => {
    const { connectorId, accountId } = await seedConnectorWithData();
    let release!: () => void;
    fetchGate = new Promise<void>((resolve) => (release = resolve));
    await call('POST', `/connectors/${connectorId}/sync`, bToken);
    await entered;
    const del = call('DELETE', `/connectors/${connectorId}?mode=keep`, bToken);
    release();
    expect((await del).statusCode).toBe(204);
    await app.ctx.sync.idle();
    const [account] = await database.db.select().from(accounts).where(eq(accounts.id, accountId));
    expect(account?.connectorId).toBeNull();
    expect((await counts()).connectors).toBe(0);
  });

  it('a sync queued behind a delete ends in error without writing and without a stray sync run', async () => {
    const { connectorId } = await seedConnectorWithData();
    const { runSync } = await import('@budgedino/server/sync/run');
    await call('DELETE', `/connectors/${connectorId}?mode=purge`, bToken);
    const result = await runSync(
      {
        db: database.db,
        keyring,
        registry: createConnectorRegistry([gatedFake()]),
        logger: createLogger({ level: 'silent' }),
        now: () => new Date(),
        onIngested: async () => undefined,
      },
      connectorId,
      'user',
    ).catch((err: unknown) => err);
    // either an 'error' outcome or the FK rejection of the run row: never a successful write
    expect(result instanceof Error || (result as { outcome: string }).outcome === 'error').toBe(
      true,
    );
    expect((await counts()).accounts).toBe(0);
  });
});

describe('PATCH /connectors/:id', () => {
  it('renames an own connector; the name is encrypted at rest and shown to the owner only', async () => {
    const { connectorId } = await seedConnectorWithData();
    const res = await call('PATCH', `/connectors/${connectorId}`, bToken, {
      displayName: '  Anna private DKB  ',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: connectorId,
      displayName: 'Anna private DKB',
      bank: 'fake',
      isOwner: true,
    });
    const dump = await database.dumpData();
    expect(dump).not.toContain('Anna private DKB');
    const [row] = await database.db.select().from(connectors).where(eq(connectors.id, connectorId));
    expect(row?.displayNameEnc).not.toBeNull();

    const own = (await call('GET', '/connectors', bToken)).json<{
      connectors: Record<string, unknown>[];
    }>();
    expect(own.connectors[0]).toMatchObject({ displayName: 'Anna private DKB', bank: 'fake' });
    const shared = (await call('GET', '/connectors', aToken)).json<{
      connectors: Record<string, unknown>[];
    }>();
    expect(shared.connectors[0]).toMatchObject({ isOwner: false, bank: 'fake' });
    expect(shared.connectors[0]).not.toHaveProperty('displayName');
    expect(JSON.stringify(shared)).not.toContain('Anna');
  });

  it('clears the name with null and validates the body', async () => {
    const { connectorId } = await seedConnectorWithData();
    await call('PATCH', `/connectors/${connectorId}`, bToken, { displayName: 'X' });
    const cleared = await call('PATCH', `/connectors/${connectorId}`, bToken, {
      displayName: null,
    });
    expect(cleared.json()).toMatchObject({ displayName: null });
    for (const bad of [
      { displayName: '' },
      { displayName: '   ' },
      { displayName: 'x'.repeat(61) },
    ]) {
      expect((await call('PATCH', `/connectors/${connectorId}`, bToken, bad)).statusCode).toBe(400);
    }
    expect((await call('PATCH', `/connectors/${connectorId}`, bToken, {})).statusCode).toBe(400);
  });

  it('returns 404 for another member (admin included) and changes nothing', async () => {
    const { connectorId } = await seedConnectorWithData();
    const res = await call('PATCH', `/connectors/${connectorId}`, aToken, { displayName: 'Mine' });
    expect(res.statusCode).toBe(404);
    const [row] = await database.db.select().from(connectors).where(eq(connectors.id, connectorId));
    expect(row?.displayNameEnc).toBeNull();
    expect(
      (await call('PATCH', `/connectors/${newId()}`, bToken, { displayName: 'x' })).statusCode,
    ).toBe(404);
  });
});

describe('connector bank id', () => {
  it('POST /connectors writes the plaintext bank (the type when there is no bank concept)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/connectors',
      headers: { authorization: `Bearer ${bToken}` },
      payload: { type: 'fake', config: { scenario: 'decoupled' } },
    });
    expect(res.statusCode).toBe(200);
    const { connectorId } = res.json<{ connectorId: string }>();
    const [row] = await database.db.select().from(connectors).where(eq(connectors.id, connectorId));
    expect(row?.bank).toBe('fake');
  });

  it('backfills rows without a bank from the encrypted config, once', async () => {
    const dk = await keyring.forHousehold(householdId);
    const make = async (type: string, config: object) => {
      const id = newId();
      await database.db.insert(connectors).values({
        id,
        householdId,
        ownerMemberId: bId,
        type,
        configEnc: encryptField(dk, JSON.stringify(config), {
          table: 'connectors',
          column: 'config',
          rowId: id,
        }),
      });
      return id;
    };
    const dkb = await make('fints', { bank: 'dkb', userId: 'u', pin: 'p' });
    const comdirect = await make('fints', { bank: 'comdirect', userId: 'u', pin: 'p' });
    const fake = await make('fake', {});
    const logger = createLogger({ level: 'silent' });
    expect(await backfillConnectorBanks(database.db, keyring, logger)).toBe(3);
    const rows = await database.db.select().from(connectors);
    const bankOf = (id: string) => rows.find((r) => r.id === id)?.bank;
    expect([bankOf(dkb), bankOf(comdirect), bankOf(fake)]).toEqual(['dkb', 'comdirect', 'fake']);
    expect(await backfillConnectorBanks(database.db, keyring, logger)).toBe(0);
  });
});

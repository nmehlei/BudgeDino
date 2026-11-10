import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '@budgedino/server/app';
import { visibleAccountIds } from '@budgedino/server/access/visibility';
import { DEFAULT_CATEGORIES } from '@budgedino/server/categorization/defaults';
import { detectTransfers } from '@budgedino/server/categorization/transfers';
import { backfillConnectorBanks } from '@budgedino/server/connectors/bank-backfill';
import { createFakeConnector } from '@budgedino/server/connectors/fake/fake-connector';
import { createConnectorRegistry } from '@budgedino/server/connectors/registry';
import type { Connector } from '@budgedino/server/connectors/types';
import { encryptField } from '@budgedino/server/crypto';
import { newId } from '@budgedino/server/db/ids';
import {
  accounts,
  categories,
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

  it('purge releases the surviving halves of transfer pairs so they count again and can be re-paired', async () => {
    await database.db.insert(categories).values(
      DEFAULT_CATEGORIES.map((c) => ({
        householdId,
        name: c.name,
        isIncome: c.isIncome ?? false,
        isTransfer: c.isTransfer ?? false,
      })),
    );
    const dk = await keyring.forHousehold(householdId);
    const purged = await seedFakeConnector(database.db, keyring, householdId, bId);
    const kept = await seedFakeConnector(database.db, keyring, householdId, bId, {
      accountRef: 'fake-2',
    });
    const tx = (accountId: string, dedupKey: string, amountMinor: bigint) =>
      createTransaction(database.db, dk, {
        accountId,
        dedupKey,
        status: 'booked',
        bookingDate: '2026-11-03',
        amountMinor,
        currency: 'EUR',
        counterparty: 'Own account',
      });
    const outId = await tx(purged.accountId, 'out', -25_000n);
    const inId = await tx(kept.accountId, 'in', 25_000n);
    await detectTransfers(database.db, keyring, householdId, [outId, inId]);
    const row = async (id: string) => {
      const [r] = await database.db.select().from(transactions).where(eq(transactions.id, id));
      return r as typeof transactions.$inferSelect;
    };
    const paired = await row(inId);
    expect(paired.transferGroupId).not.toBeNull();
    const transferCategoryId = paired.categoryId;
    expect(transferCategoryId).not.toBeNull();

    const del = await call('DELETE', `/connectors/${purged.connectorId}?mode=purge`, bToken);
    expect(del.statusCode).toBe(204);
    const survivor = await row(inId);
    expect(survivor.transferGroupId).toBeNull(); // counts toward budgets again
    expect(survivor.categoryId).not.toBe(transferCategoryId); // no stale Transfer category
    expect((await database.db.select().from(transactions)).length).toBe(1);

    // a later connection can pair it again
    const again = await seedFakeConnector(database.db, keyring, householdId, bId, {
      accountRef: 'fake-3',
    });
    const outAgain = await tx(again.accountId, 'out-again', -25_000n);
    await detectTransfers(database.db, keyring, householdId, [outAgain]);
    const repaired = await row(inId);
    expect(repaired.transferGroupId).not.toBeNull();
    expect((await row(outAgain)).transferGroupId).toBe(repaired.transferGroupId);
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
    // the connector vanished: the run ends skipped (no failure, no run row, no write)
    expect(result).toEqual({ runId: null, outcome: 'skipped' });
    expect(await database.db.select().from(syncRuns)).toEqual([]);
    expect((await counts()).accounts).toBe(0);
  });
});

describe('reconnecting after keep', () => {
  const fakeTx = {
    providerId: 'p-1',
    status: 'booked',
    bookingDate: '2026-11-05',
    amountMinor: '-5000',
    currency: 'EUR',
    counterparty: 'Supermarket',
  };
  const connect = async (token: string, accountDefaults?: object) => {
    const res = await call('POST', '/connectors', token, {
      type: 'fake',
      config: { scenario: 'happy', transactions: [fakeTx] },
      ...(accountDefaults ? { accountDefaults } : {}),
    });
    expect(res.statusCode, res.body).toBe(200);
    await app.ctx.sync.idle();
    return res.json<{ connectorId: string }>().connectorId;
  };
  const worth = async (token: string) =>
    (await call('GET', '/net-worth', token)).json<{ total: { minor: string } }>().total.minor;

  it('re-links the disconnected account: one account, no duplicate transactions, balance counted once', async () => {
    const first = await connect(bToken, { visibility: 'owner_only' });
    const [original] = await database.db.select().from(accounts);
    const originalId = (original as { id: string }).id;
    const dk = await keyring.forHousehold(householdId);
    await database.db
      .update(accounts)
      .set({
        balanceEnc: encryptField(dk, '123400', {
          table: 'accounts',
          column: 'balance',
          rowId: originalId,
        }),
        balanceAt: new Date(),
        countsTowardBudgets: true, // the user changed it after connecting
      })
      .where(eq(accounts.id, originalId));
    expect((await counts()).transactions).toBe(1);
    expect(await worth(bToken)).toBe('123400');

    expect((await call('DELETE', `/connectors/${first}?mode=keep`, bToken)).statusCode).toBe(204);
    // the new connection asks for other defaults; the kept account keeps what the user set
    const second = await connect(bToken, { visibility: 'household' });

    const rows = await database.db.select().from(accounts);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: originalId,
      connectorId: second,
      disconnectedAt: null,
      visibility: 'owner_only',
      countsTowardBudgets: true,
    });
    expect((await counts()).transactions).toBe(1);
    expect(await worth(bToken)).toBe('123400');
    // the other member still cannot see it
    const others = await call('GET', '/accounts', aToken);
    expect(others.json<{ accounts: unknown[] }>().accounts).toEqual([]);
  });

  it("does not re-link another member's disconnected account", async () => {
    const first = await connect(bToken);
    await call('DELETE', `/connectors/${first}?mode=keep`, bToken);
    await connect(aToken);
    const rows = await database.db.select().from(accounts);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.connectorId === null)).toHaveLength(1);
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
    const unknown = await make('fints', { bank: 'nobank', userId: 'u', pin: 'p' });
    const garbage = newId();
    await database.db.insert(connectors).values({
      id: garbage,
      householdId,
      ownerMemberId: bId,
      type: 'fints',
      configEnc: Buffer.from('not decryptable'),
    });
    expect(await backfillConnectorBanks(database.db, keyring, logger)).toBe(4);
    const rows = await database.db.select().from(connectors);
    const bankOf = (id: string) => rows.find((r) => r.id === id)?.bank;
    expect([bankOf(dkb), bankOf(comdirect), bankOf(fake)]).toEqual(['dkb', 'comdirect', 'fake']);
    // unknown bank and undecryptable config fall back to the type, so they are not rescanned
    expect([bankOf(unknown), bankOf(garbage)]).toEqual(['fints', 'fints']);
    expect(await backfillConnectorBanks(database.db, keyring, logger)).toBe(0);
  });
});

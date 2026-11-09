import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '@budgedino/server/app';
import { visibleAccountIds } from '@budgedino/server/access/visibility';
import type { DataKey, MasterKey } from '@budgedino/server/crypto';
import { Keyring } from '@budgedino/server/households/keyring';
import { createLogger } from '@budgedino/server/observability/logger';
import { createAccount, getAccount, listAccounts } from '@budgedino/server/repositories/accounts';
import {
  createTransaction,
  getTransaction,
  listTransactions,
} from '@budgedino/server/repositories/transactions';
import {
  createHousehold,
  createTestConnector,
  createTestMember,
  createTestSession,
  randomMasterKey,
} from '../../support/factories.js';
import { startTestDatabase, type TestDatabase } from '../../support/postgres.js';
import { resolveRouteUrl } from '../../support/route-fixtures.js';

const CANARY_PAYEE = 'CANARY-PAYEE-OWNERONLY';
const CANARY_ACCOUNT_NAME = 'CANARY-ACCOUNT-OWNERONLY';
const CANARY_IBAN = 'DE89370400440532013000';

let database: TestDatabase;
let master: MasterKey;
let keyring: Keyring;
let app: FastifyInstance;

beforeAll(async () => {
  database = await startTestDatabase();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await database.stop();
});

interface Seed {
  householdId: string;
  dk: DataKey;
  aId: string;
  bId: string;
  aToken: string;
  bToken: string;
  hiddenAccountId: string;
  hiddenTransactionIds: string[];
  aOwnAccountId: string;
}

let seed: Seed;

beforeEach(async () => {
  await app?.close();
  await database.reset();
  master = randomMasterKey();
  keyring = new Keyring(database.db, master);
  app = buildApp({
    db: database.db,
    keyring,
    master,
    logger: createLogger({ level: 'silent' }),
  });
  await app.ready();

  const householdId = await createHousehold(database.db, keyring);
  const dk = await keyring.forHousehold(householdId);
  const aId = await createTestMember(database.db, keyring, householdId, { role: 'admin' });
  const bId = await createTestMember(database.db, keyring, householdId, { role: 'member' });
  const aToken = await createTestSession(database.db, keyring, householdId, aId);
  const bToken = await createTestSession(database.db, keyring, householdId, bId);

  const bConnector = await createTestConnector(database.db, keyring, householdId, bId);
  const hiddenAccountId = await createAccount(database.db, dk, {
    connectorId: bConnector,
    ownerMemberId: bId,
    externalRef: 'b-ref',
    name: CANARY_ACCOUNT_NAME,
    iban: CANARY_IBAN,
    kind: 'checking',
    currency: 'EUR',
    visibility: 'household', // toggled to owner_only by the tests
    balanceMinor: 424_242n,
  });
  const hiddenTransactionIds: string[] = [];
  for (const n of [1, 2]) {
    hiddenTransactionIds.push(
      await createTransaction(database.db, dk, {
        accountId: hiddenAccountId,
        dedupKey: `b-tx-${n}`,
        status: 'booked',
        bookingDate: '2026-11-01',
        amountMinor: -1_000n * BigInt(n),
        currency: 'EUR',
        counterparty: CANARY_PAYEE,
      }),
    );
  }
  const aConnector = await createTestConnector(database.db, keyring, householdId, aId);
  const aOwnAccountId = await createAccount(database.db, dk, {
    connectorId: aConnector,
    ownerMemberId: aId,
    externalRef: 'a-ref',
    name: 'A checking',
    kind: 'checking',
    currency: 'EUR',
  });
  seed = {
    householdId,
    dk,
    aId,
    bId,
    aToken,
    bToken,
    hiddenAccountId,
    hiddenTransactionIds,
    aOwnAccountId,
  };
});

async function get(url: string, token: string) {
  const res = await app.inject({
    method: 'GET',
    url,
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: res.statusCode, body: res.body };
}

async function patch(url: string, token: string, payload: unknown) {
  const res = await app.inject({
    method: 'PATCH',
    url: `/api/v1${url}`,
    headers: { authorization: `Bearer ${token}` },
    payload: payload as object,
  });
  return {
    status: res.statusCode,
    json: JSON.parse(res.body || 'null') as Record<string, unknown>,
  };
}

/** Every registered GET route, probed as the given member; returns the concatenated bodies. */
async function sweepAllGetRoutes(token: string): Promise<string> {
  const routes = app.routeRegistry.filter((r) => r.method === 'GET' && r.access !== 'public');
  expect(routes.length).toBeGreaterThan(0);
  const bodies: string[] = [];
  for (const route of routes) {
    const url = resolveRouteUrl(route.url, {
      hiddenAccountId: seed.hiddenAccountId,
      hiddenTransactionId: seed.hiddenTransactionIds[0] as string,
      hiddenMemberId: seed.bId,
    });
    const res = await get(url, token);
    expect(res.status, `${route.url} must not fail`).toBeLessThan(500);
    bodies.push(res.body);
  }
  return bodies.join('\n');
}

function expectNoLeak(text: string) {
  expect(text).not.toContain(seed.hiddenAccountId);
  for (const id of seed.hiddenTransactionIds) expect(text).not.toContain(id);
  expect(text).not.toContain(CANARY_PAYEE);
  expect(text).not.toContain(CANARY_ACCOUNT_NAME);
  expect(text).not.toContain('•••• 3000'); // masked IBAN
  expect(text).not.toContain('"424242"'); // balance
}

describe('visibility enforcement', () => {
  it('shows a household account to the admin, with masked IBAN (positive control)', async () => {
    const res = await get('/api/v1/accounts', seed.aToken);
    expect(res.status).toBe(200);
    const accounts = (JSON.parse(res.body) as { accounts: Record<string, unknown>[] }).accounts;
    const b = accounts.find((a) => a['id'] === seed.hiddenAccountId);
    expect(b).toMatchObject({
      name: CANARY_ACCOUNT_NAME,
      ibanMasked: '•••• 3000',
      balanceMinor: '424242',
      isOwner: false,
    });
    expect(res.body).not.toContain(CANARY_IBAN);
  });

  it('owner_only account is invisible to the admin on every GET route', async () => {
    await patch(`/accounts/${seed.hiddenAccountId}`, seed.bToken, { visibility: 'owner_only' });
    expectNoLeak(await sweepAllGetRoutes(seed.aToken));
    // ...but still visible to its owner
    const own = await get('/api/v1/accounts', seed.bToken);
    expect(own.body).toContain(seed.hiddenAccountId);
  });

  it('toggling household -> owner_only hides it immediately', async () => {
    expect(await sweepAllGetRoutes(seed.aToken)).toContain(seed.hiddenAccountId);
    const res = await patch(`/accounts/${seed.hiddenAccountId}`, seed.bToken, {
      visibility: 'owner_only',
    });
    expect(res.status).toBe(200);
    expectNoLeak(await sweepAllGetRoutes(seed.aToken));
  });

  it('visibleAccountIds contains household accounts and own accounts only', async () => {
    const ids = await visibleAccountIds(database.db, {
      memberId: seed.aId,
      householdId: seed.householdId,
    });
    expect([...ids].sort()).toEqual([seed.hiddenAccountId, seed.aOwnAccountId].sort());
    await patch(`/accounts/${seed.hiddenAccountId}`, seed.bToken, { visibility: 'owner_only' });
    const after = await visibleAccountIds(database.db, {
      memberId: seed.aId,
      householdId: seed.householdId,
    });
    expect([...after]).toEqual([seed.aOwnAccountId]);
    const bIds = await visibleAccountIds(database.db, {
      memberId: seed.bId,
      householdId: seed.householdId,
    });
    expect([...bIds].sort()).toEqual([seed.hiddenAccountId, seed.aOwnAccountId].sort());
  });

  it('does not see accounts of another household', async () => {
    const otherHousehold = await createHousehold(database.db, keyring, 'other');
    const outsider = await createTestMember(database.db, keyring, otherHousehold);
    const ids = await visibleAccountIds(database.db, {
      memberId: outsider,
      householdId: otherHousehold,
    });
    expect([...ids]).toEqual([]);
  });

  it('transaction and account repositories only read through a visibility scope', async () => {
    await patch(`/accounts/${seed.hiddenAccountId}`, seed.bToken, { visibility: 'owner_only' });
    const scopeA = await visibleAccountIds(database.db, {
      memberId: seed.aId,
      householdId: seed.householdId,
    });
    const scopeB = await visibleAccountIds(database.db, {
      memberId: seed.bId,
      householdId: seed.householdId,
    });
    const txId = seed.hiddenTransactionIds[0] as string;

    expect(await listTransactions(database.db, seed.dk, scopeA)).toEqual([]);
    expect(await listTransactions(database.db, seed.dk, scopeA, seed.hiddenAccountId)).toEqual([]);
    await expect(getTransaction(database.db, seed.dk, scopeA, txId)).rejects.toThrow(/not found/i);
    await expect(getAccount(database.db, seed.dk, scopeA, seed.hiddenAccountId)).rejects.toThrow(
      /not found/i,
    );
    expect((await listAccounts(database.db, seed.dk, scopeA)).map((a) => a.id)).not.toContain(
      seed.hiddenAccountId,
    );

    expect(await listTransactions(database.db, seed.dk, scopeB)).toHaveLength(2);
    expect((await getTransaction(database.db, seed.dk, scopeB, txId)).counterparty).toBe(
      CANARY_PAYEE,
    );
  });
});

describe('PATCH /accounts/:id', () => {
  it('returns 404 (not 403) for a non-owner, even an admin, and changes nothing', async () => {
    const res = await patch(`/accounts/${seed.hiddenAccountId}`, seed.aToken, {
      visibility: 'owner_only',
    });
    expect(res.status).toBe(404);
    const { rows } = await database.pool.query<{ visibility: string }>(
      'select visibility from accounts where id = $1',
      [seed.hiddenAccountId],
    );
    expect(rows[0]?.visibility).toBe('household');
    // a non-existent id looks identical
    const missing = await patch('/accounts/8a1a4bc0-6d5e-4f0a-8f2a-0a6f9d1e2c3b', seed.aToken, {
      visibility: 'owner_only',
    });
    expect(missing.status).toBe(404);
    expect(missing.json).toEqual(res.json);
  });

  it('owner_only sets countsTowardBudgets=false unless passed explicitly', async () => {
    const res = await patch(`/accounts/${seed.hiddenAccountId}`, seed.bToken, {
      visibility: 'owner_only',
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ visibility: 'owner_only', countsTowardBudgets: false });

    const explicit = await patch(`/accounts/${seed.aOwnAccountId}`, seed.aToken, {
      visibility: 'owner_only',
      countsTowardBudgets: true,
    });
    expect(explicit.json).toMatchObject({ visibility: 'owner_only', countsTowardBudgets: true });
  });

  it('toggles countsTowardBudgets alone and validates the body', async () => {
    const ok = await patch(`/accounts/${seed.aOwnAccountId}`, seed.aToken, {
      countsTowardBudgets: false,
    });
    expect(ok.json).toMatchObject({ visibility: 'household', countsTowardBudgets: false });
    expect((await patch(`/accounts/${seed.aOwnAccountId}`, seed.aToken, {})).status).toBe(400);
    expect(
      (await patch(`/accounts/${seed.aOwnAccountId}`, seed.aToken, { visibility: 'x' })).status,
    ).toBe(400);
    expect(
      (await patch(`/accounts/${seed.aOwnAccountId}`, seed.aToken, { name: 'n' })).status,
    ).toBe(400);
  });

  it('requires authentication', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/accounts/${seed.hiddenAccountId}`,
      payload: { visibility: 'owner_only' },
    });
    expect(res.statusCode).toBe(401);
  });
});

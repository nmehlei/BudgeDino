import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NetWorthResponse } from '@budgedino/shared';
import { buildApp } from '@budgedino/server/app';
import { fxRates } from '@budgedino/server/db/schema';
import { Keyring } from '@budgedino/server/households/keyring';
import { createLogger } from '@budgedino/server/observability/logger';
import { createAccount } from '@budgedino/server/repositories/accounts';
import {
  createHousehold,
  createTestConnector,
  createTestMember,
  createTestSession,
  randomMasterKey,
} from '../../support/factories.js';
import { startTestDatabase, type TestDatabase } from '../../support/postgres.js';

let database: TestDatabase;
let keyring: Keyring;
let app: FastifyInstance;
let householdId: string;
let aId: string;
let bId: string;
let aToken: string;
let bToken: string;
let bConnector: string;
let aConnector: string;

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
    now: () => new Date('2026-11-10T12:00:00Z'),
  });
  await app.ready();
  householdId = await createHousehold(database.db, keyring);
  aId = await createTestMember(database.db, keyring, householdId, { role: 'admin' });
  bId = await createTestMember(database.db, keyring, householdId, { role: 'member' });
  aToken = await createTestSession(database.db, keyring, householdId, aId);
  bToken = await createTestSession(database.db, keyring, householdId, bId);
  aConnector = await createTestConnector(database.db, keyring, householdId, aId);
  bConnector = await createTestConnector(database.db, keyring, householdId, bId);
  await database.db.insert(fxRates).values([
    { date: '2026-11-09', currency: 'USD', ratePerEur: '1.1000' },
    { date: '2026-11-07', currency: 'USD', ratePerEur: '1.2000' }, // older, superseded
  ]);
});

async function add(
  owner: 'a' | 'b',
  name: string,
  kind: 'checking' | 'savings' | 'credit_card' | 'depot' | 'other',
  currency: string,
  balanceMinor?: bigint,
  visibility: 'household' | 'owner_only' = 'household',
) {
  const dk = await keyring.forHousehold(householdId);
  return createAccount(database.db, dk, {
    connectorId: owner === 'a' ? aConnector : bConnector,
    ownerMemberId: owner === 'a' ? aId : bId,
    externalRef: name,
    name,
    kind,
    currency,
    visibility,
    ...(balanceMinor === undefined ? {} : { balanceMinor }),
  });
}

const getNetWorth = async (token: string) => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/net-worth',
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: res.statusCode, body: res.json<NetWorthResponse>(), raw: res.body };
};

describe('GET /net-worth', () => {
  it('requires authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/net-worth' });
    expect(res.statusCode).toBe(401);
  });

  it('is empty without accounts', async () => {
    const { status, body } = await getNetWorth(aToken);
    expect(status).toBe(200);
    expect(body).toEqual({
      baseCurrency: 'EUR',
      total: { minor: '0', currency: 'EUR' },
      fxMissing: false,
      groups: [],
    });
  });

  it('sums converted balances, groups by kind and lists accounts without a balance', async () => {
    await add('b', 'Girokonto', 'checking', 'EUR', 100_000n);
    await add('b', 'Tagesgeld', 'savings', 'EUR', 50_000n);
    await add('b', 'Visa', 'credit_card', 'EUR', -20_000n);
    await add('b', 'US Depot', 'depot', 'USD', 100_000n); // 1000.00 USD at 1.10 -> 909.09 EUR
    await add('b', 'Neues Konto', 'checking', 'EUR'); // no balance yet

    const { status, body } = await getNetWorth(bToken);
    expect(status).toBe(200);
    expect(body.baseCurrency).toBe('EUR');
    expect(body.total).toEqual({ minor: '220909', currency: 'EUR' });
    expect(body.fxMissing).toBe(false);
    expect(body.groups.map((g) => g.kind)).toEqual(['checking', 'savings', 'credit_card', 'depot']);
    const group = (kind: string) => body.groups.find((g) => g.kind === kind);
    expect(group('checking')?.total).toEqual({ minor: '100000', currency: 'EUR' });
    expect(group('checking')?.accounts.map((a) => a.name)).toEqual(['Girokonto', 'Neues Konto']);
    expect(group('credit_card')?.total).toEqual({ minor: '-20000', currency: 'EUR' });
    // group totals add up to the overall total
    expect(body.groups.reduce((s, g) => s + BigInt(g.total.minor), 0n)).toBe(220909n);

    const depot = group('depot')?.accounts[0];
    expect(depot).toMatchObject({
      name: 'US Depot',
      isOwner: true,
      disconnected: false,
      balance: { minor: '100000', currency: 'USD' },
      baseBalance: { minor: '90909', currency: 'EUR' },
    });
    expect(depot?.balanceAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const fresh = group('checking')?.accounts.find((a) => a.name === 'Neues Konto');
    expect(fresh).toMatchObject({ balance: null, baseBalance: null, balanceAt: null });
  });

  it('leaves accounts without an FX rate out of the totals and flags them', async () => {
    await add('b', 'Girokonto', 'checking', 'EUR', 10_000n);
    await add('b', 'Franken', 'savings', 'CHF', 5_000n); // no CHF rate in fx_rates
    const { body } = await getNetWorth(bToken);
    expect(body.total).toEqual({ minor: '10000', currency: 'EUR' });
    expect(body.fxMissing).toBe(true);
    const savings = body.groups.find((g) => g.kind === 'savings');
    expect(savings).toMatchObject({ fxMissing: true, total: { minor: '0', currency: 'EUR' } });
    expect(savings?.accounts[0]).toMatchObject({
      balance: { minor: '5000', currency: 'CHF' },
      baseBalance: null,
    });
    expect(body.groups.find((g) => g.kind === 'checking')?.fxMissing).toBe(false);
  });

  it("excludes another member's owner-only account, but the owner sees it", async () => {
    await add('a', 'Gemeinsam', 'checking', 'EUR', 10_000n);
    await add('b', 'Geheim', 'savings', 'EUR', 999_999n, 'owner_only');

    const asA = await getNetWorth(aToken);
    expect(asA.body.total).toEqual({ minor: '10000', currency: 'EUR' });
    expect(asA.raw).not.toContain('Geheim');
    expect(asA.raw).not.toContain('999999');

    const asB = await getNetWorth(bToken);
    expect(asB.body.total).toEqual({ minor: '1009999', currency: 'EUR' });
    expect(asB.body.groups.flatMap((g) => g.accounts).map((a) => a.name)).toContain('Geheim');
  });

  it('marks accounts of a removed connection (keep history) as disconnected and still counts them', async () => {
    await add('b', 'Altkonto', 'checking', 'EUR', 7_000n);
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/connectors/${bConnector}?mode=keep`,
      headers: { authorization: `Bearer ${bToken}` },
    });
    expect(res.statusCode).toBe(204);
    const { body } = await getNetWorth(bToken);
    expect(body.total).toEqual({ minor: '7000', currency: 'EUR' });
    expect(body.groups[0]?.accounts[0]).toMatchObject({ name: 'Altkonto', disconnected: true });
  });
});

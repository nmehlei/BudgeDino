import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '@budgedino/server/app';
import { generateTotpCode } from '@budgedino/server/auth/totp';
import { createConnectorRegistry } from '@budgedino/server/connectors/registry';
import { createFakeConnector } from '@budgedino/server/connectors/fake/fake-connector';
import {
  accounts,
  households,
  transactions,
  budgets,
  connectors,
} from '@budgedino/server/db/schema';
import { devSeed, DEMO_EMAIL, DEMO_PASSWORD, SeedError } from '@budgedino/server/dev/seed';
import { Keyring } from '@budgedino/server/households/keyring';
import { createLogger } from '@budgedino/server/observability/logger';
import { randomMasterKey } from '../../support/factories.js';
import { startTestDatabase, type TestDatabase } from '../../support/postgres.js';

let database: TestDatabase;

beforeAll(async () => {
  database = await startTestDatabase();
}, 120_000);

afterAll(async () => {
  await database.stop();
});

beforeEach(async () => {
  await database.reset();
});

const NOW = new Date('2026-11-09T12:00:00Z');
const TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const env = { NODE_ENV: 'development', BUDGEDINO_DEV_TOTP_SECRET: TOTP_SECRET };

function setup() {
  const master = randomMasterKey();
  const keyring = new Keyring(database.db, master);
  const app = buildApp({
    db: database.db,
    keyring,
    master,
    logger: createLogger({ level: 'silent' }),
    registry: createConnectorRegistry([createFakeConnector()]),
    now: () => NOW,
  });
  return { keyring, app };
}

async function count(
  table: typeof households | typeof transactions | typeof budgets | typeof connectors,
) {
  return (await database.db.select().from(table)).length;
}

describe('devSeed', () => {
  it('creates the household and an invite, is idempotent, and gives a fresh invite per run', async () => {
    const { keyring } = setup();
    const first = await devSeed({ db: database.db, keyring }, { withData: false, env, now: NOW });
    const second = await devSeed({ db: database.db, keyring }, { withData: false, env, now: NOW });
    expect(first.householdCreated).toBe(true);
    expect(second.householdCreated).toBe(false);
    expect(second.householdId).toBe(first.householdId);
    expect(second.inviteToken).not.toBe(first.inviteToken);
    expect(await count(households)).toBe(1);
    expect(first.data).toBeUndefined();
  });

  it('refuses in production and creates nothing', async () => {
    const { keyring } = setup();
    await expect(
      devSeed({ db: database.db, keyring }, { withData: true, env: { NODE_ENV: 'production' } }),
    ).rejects.toThrow(SeedError);
    expect(await count(households)).toBe(0);
  });

  it('is opt-in: refuses without NODE_ENV=development unless acknowledged, never in production', async () => {
    const { keyring } = setup();
    await expect(
      devSeed({ db: database.db, keyring }, { withData: false, env: {} }),
    ).rejects.toThrow(SeedError);
    await expect(
      devSeed(
        { db: database.db, keyring },
        { withData: false, acknowledgedDev: true, env: { NODE_ENV: 'production' } },
      ),
    ).rejects.toThrow(SeedError);
    expect(await count(households)).toBe(0);
    const ok = await devSeed(
      { db: database.db, keyring },
      { withData: false, acknowledgedDev: true, env: {}, now: NOW },
    );
    expect(ok.householdCreated).toBe(true);
  });

  it('completes a partially seeded connector (connector without account or transactions)', async () => {
    const { keyring } = setup();
    const first = await devSeed({ db: database.db, keyring }, { withData: true, env, now: NOW });
    // Simulate a crash after the connector insert: drop the account (cascades to its transactions).
    await database.db.delete(accounts);
    expect(await count(transactions)).toBe(0);
    const again = await devSeed({ db: database.db, keyring }, { withData: true, env, now: NOW });
    expect(again.data?.connectorId).toBe(first.data?.connectorId);
    expect(await count(connectors)).toBe(1);
    expect(await count(transactions)).toBe(first.data?.transactionCount);
  });

  it('--with-data is idempotent: one connector, no duplicate transactions or budgets', async () => {
    const { keyring } = setup();
    const a = await devSeed({ db: database.db, keyring }, { withData: true, env, now: NOW });
    const txCount = await count(transactions);
    expect(txCount).toBe(a.data?.transactionCount);
    const b = await devSeed({ db: database.db, keyring }, { withData: true, env, now: NOW });
    expect(await count(households)).toBe(1);
    expect(await count(connectors)).toBe(1);
    expect(await count(transactions)).toBe(txCount);
    expect(await count(budgets)).toBe(2);
    expect(b.data?.connectorId).toBe(a.data?.connectorId);
    expect(b.data?.totpSecret).toBe(TOTP_SECRET);
  });

  it('--with-data gives the seeded admin real numbers on /home', async () => {
    const { keyring, app } = setup();
    try {
      const seeded = await devSeed({ db: database.db, keyring }, { withData: true, env, now: NOW });
      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: DEMO_EMAIL,
          password: DEMO_PASSWORD,
          totpCode: generateTotpCode(seeded.data?.totpSecret ?? '', NOW.getTime()),
          deviceName: 'seed test',
        },
      });
      expect(login.statusCode).toBe(200);
      const { sessionToken } = login.json<{ sessionToken: string }>();
      const home = await app.inject({
        method: 'GET',
        url: '/api/v1/home',
        headers: { authorization: `Bearer ${sessionToken}` },
      });
      expect(home.statusCode).toBe(200);
      const body = home.json<{
        budgets: { name: string; amount: { minor: string }; spent: { minor: string } }[];
        income: { minor: string };
      }>();
      const byName = Object.fromEntries(body.budgets.map((b) => [b.name, b]));
      expect(byName['Groceries']?.amount.minor).toBe('50000');
      expect(byName['Eating out']?.amount.minor).toBe('6000');
      expect(BigInt(byName['Groceries']?.spent.minor ?? '0')).toBeGreaterThan(0n);
      expect(BigInt(byName['Eating out']?.spent.minor ?? '0')).toBeGreaterThan(0n);
    } finally {
      await app.close();
    }
  });

  it('the seeded fake connector can be reconnected with the decoupled demo config', async () => {
    const { keyring, app } = setup();
    try {
      const seeded = await devSeed({ db: database.db, keyring }, { withData: true, env, now: NOW });
      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: DEMO_EMAIL,
          password: DEMO_PASSWORD,
          totpCode: generateTotpCode(seeded.data?.totpSecret ?? '', NOW.getTime()),
          deviceName: 'seed test',
        },
      });
      const { sessionToken } = login.json<{ sessionToken: string }>();
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/connectors',
        headers: { authorization: `Bearer ${sessionToken}` },
        payload: { type: 'fake', config: { scenario: 'decoupled' } },
      });
      expect(created.statusCode).toBe(200);
      expect(created.json<{ challenge?: { kind: string } }>().challenge?.kind).toBe('decoupled');
    } finally {
      await app.close();
    }
  });
});

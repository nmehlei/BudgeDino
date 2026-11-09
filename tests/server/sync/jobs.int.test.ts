import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createFakeConnector } from '@budgedino/server/connectors/fake/fake-connector';
import { createConnectorRegistry } from '@budgedino/server/connectors/registry';
import { challenges, syncRuns } from '@budgedino/server/db/schema';
import { Keyring } from '@budgedino/server/households/keyring';
import { createLogger } from '@budgedino/server/observability/logger';
import {
  CHALLENGES_EXPIRE_QUEUE,
  FX_REFRESH_QUEUE,
  startJobs,
  type JobsHandle,
} from '@budgedino/server/sync/jobs';
import {
  createHousehold,
  createTestChallenge,
  createTestMember,
  randomMasterKey,
} from '../../support/factories.js';
import { startTestDatabase, type TestDatabase } from '../../support/postgres.js';
import { seedFakeConnector } from '../../support/sync.js';

let database: TestDatabase;
let jobs: JobsHandle | undefined;

beforeAll(async () => {
  database = await startTestDatabase();
}, 120_000);
afterAll(async () => {
  await jobs?.stop();
  await database.stop();
});

it('smoke: pg-boss starts against the DB and runs a queued sync.connector job', async () => {
  const keyring = new Keyring(database.db, randomMasterKey());
  const householdId = await createHousehold(database.db, keyring);
  const memberId = await createTestMember(database.db, keyring, householdId);
  const { connectorId } = await seedFakeConnector(database.db, keyring, householdId, memberId);

  jobs = await startJobs(
    {
      db: database.db,
      keyring,
      registry: createConnectorRegistry([createFakeConnector()]),
      logger: createLogger({ level: 'silent' }),
      now: () => new Date(),
      onIngested: async () => {},
    },
    { connectionString: database.container.getConnectionUri(), pollingIntervalSeconds: 0.5 },
  );
  await jobs.enqueueConnector(connectorId);
  await vi.waitFor(
    async () => {
      const runs = await database.db.select().from(syncRuns);
      expect(runs.map((r) => r.outcome)).toContain('ok');
    },
    { timeout: 30_000, interval: 250 },
  );
}, 60_000);

it('the challenges.expire job expires challenges past their TTL', async () => {
  const keyring = new Keyring(database.db, randomMasterKey());
  const householdId = await createHousehold(database.db, keyring);
  const memberId = await createTestMember(database.db, keyring, householdId);
  const { connectorId } = await seedFakeConnector(database.db, keyring, householdId, memberId);
  const challengeId = await createTestChallenge(
    database.db,
    keyring,
    householdId,
    connectorId,
    memberId,
  );
  await database.db
    .update(challenges)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(challenges.id, challengeId));
  jobs = await startJobs(
    {
      db: database.db,
      keyring,
      registry: createConnectorRegistry([createFakeConnector()]),
      logger: createLogger({ level: 'silent' }),
      now: () => new Date(),
      onIngested: async () => {},
    },
    { connectionString: database.container.getConnectionUri(), pollingIntervalSeconds: 0.5 },
  );
  await jobs.boss.send(CHALLENGES_EXPIRE_QUEUE, {});
  await vi.waitFor(
    async () => {
      const [row] = await database.db
        .select()
        .from(challenges)
        .where(eq(challenges.id, challengeId));
      expect(row?.status).toBe('expired');
    },
    { timeout: 30_000, interval: 250 },
  );
}, 60_000);

it('the fx.refresh job stores the rates of the injected source, and runs once at startup', async () => {
  const keyring = new Keyring(database.db, randomMasterKey());
  await jobs?.stop();
  jobs = await startJobs(
    {
      db: database.db,
      keyring,
      registry: createConnectorRegistry([createFakeConnector()]),
      logger: createLogger({ level: 'silent' }),
      now: () => new Date(),
      onIngested: async () => {},
    },
    {
      connectionString: database.container.getConnectionUri(),
      pollingIntervalSeconds: 0.5,
      fxSource: {
        fetchRates: async () => [{ date: '2026-11-09', currency: 'USD', ratePerEur: '1.0800' }],
      },
    },
  );
  await vi.waitFor(
    async () => {
      const { rows } = await database.pool.query<{ rate_per_eur: string }>(
        `select rate_per_eur from fx_rates where currency = 'USD' and date = '2026-11-09'`,
      );
      expect(rows[0]?.rate_per_eur).toBe('1.0800');
    },
    { timeout: 30_000, interval: 250 },
  );
  expect(FX_REFRESH_QUEUE).toBe('fx.refresh');
}, 60_000);

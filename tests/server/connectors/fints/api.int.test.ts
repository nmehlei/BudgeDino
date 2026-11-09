import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '@budgedino/server/app';
import { createFinTSConnector } from '@budgedino/server/connectors/fints/connector';
import { FinTSDialogRegistry } from '@budgedino/server/connectors/fints/dialogs';
import { createConnectorRegistry } from '@budgedino/server/connectors/registry';
import { DEFAULT_CATEGORIES } from '@budgedino/server/categorization/defaults';
import { accounts, categories, connectors, notifications } from '@budgedino/server/db/schema';
import { Keyring } from '@budgedino/server/households/keyring';
import { createLogger } from '@budgedino/server/observability/logger';
import { runSync } from '@budgedino/server/sync/run';
import {
  createHousehold,
  createTestMember,
  createTestSession,
  randomMasterKey,
} from '../../../support/factories.js';
import { startTestDatabase, type TestDatabase } from '../../../support/postgres.js';
import { ScriptedFinTSPort } from '../../../support/fints/scripted-port';

const PIN = 'CANARY-PIN-4711';
const USER = 'CANARY-USER-0815';
const IBAN = 'DE89370400440532013000';
const T0 = new Date('2026-11-09T12:00:00Z').getTime();

let database: TestDatabase;

beforeAll(async () => {
  database = await startTestDatabase();
}, 120_000);
afterAll(async () => {
  await database.stop();
});

describe('fints through the real API with a scripted bank', () => {
  let app: FastifyInstance | undefined;
  afterAll(async () => {
    await app?.close();
  });

  it('connects with a decoupled challenge, ingests categorized transactions, then needs attention', async () => {
    await database.reset();
    let nowMs = T0;
    const now = () => new Date(nowMs);
    const logLines: string[] = [];
    const logger = createLogger({
      level: 'trace',
      destination: { write: (line: string) => void logLines.push(line) },
    });
    const port = new ScriptedFinTSPort({
      syncRequiresTan: 'decoupled',
      decoupledPendingPolls: 1,
      accounts: [
        {
          iban: IBAN,
          accountNumber: '532013000',
          blz: '12030000',
          accountType: 'CheckingAccount',
          currency: 'EUR',
        },
      ],
      transactions: [
        {
          valueDate: '2026-11-06',
          bookingDate: '2026-11-05',
          amount: -23.45,
          purpose: 'Kartenzahlung',
          remoteName: 'REWE Markt GmbH',
        },
        {
          valueDate: '2026-11-07',
          bookingDate: '2026-11-06',
          amount: -8.9,
          purpose: 'Einkauf',
          remoteName: 'EDEKA Nord',
        },
      ],
      balance: { value: 500, currency: 'EUR' },
    });
    const fints = createFinTSConnector({
      port,
      dialogs: new FinTSDialogRegistry({ now }),
      product: { id: 'PID', version: '1.0' },
    });
    const master = randomMasterKey();
    const keyring = new Keyring(database.db, master);
    const server = buildApp({
      db: database.db,
      keyring,
      master,
      registry: createConnectorRegistry([fints]),
      logger,
      now,
    });
    app = server;
    await server.ready();
    const householdId = await createHousehold(database.db, keyring);
    await database.db.insert(categories).values(
      DEFAULT_CATEGORIES.map((c) => ({
        householdId,
        name: c.name,
        isIncome: c.isIncome ?? false,
        isTransfer: c.isTransfer ?? false,
      })),
    );
    const ownerId = await createTestMember(database.db, keyring, householdId, { role: 'member' });
    const token = await createTestSession(database.db, keyring, householdId, ownerId);

    const bodies: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    type Json = Record<string, any>;
    async function call(method: 'GET' | 'POST', url: string, payload?: object) {
      const res = await server.inject({
        method,
        url: `/api/v1${url}`,
        headers: { authorization: `Bearer ${token}` },
        ...(payload ? { payload } : {}),
      });
      bodies.push(res.body);
      return { status: res.statusCode, json: JSON.parse(res.body || 'null') as Json };
    }

    // connect: decoupled challenge
    const connect = await call('POST', '/connectors', {
      type: 'fints',
      config: { bank: 'dkb', userId: USER, pin: PIN },
    });
    expect(connect.status, JSON.stringify(connect.json)).toBe(200);
    const { connectorId, challenge } = connect.json;
    expect(challenge.kind).toBe('decoupled');
    expect(challenge.pollAfterMs).toBeGreaterThan(0);
    expect(
      (await call('POST', `/challenges/${challenge.id}/answer`, { kind: 'decoupled' })).status,
    ).toBe(429);

    nowMs += challenge.pollAfterMs + 500;
    const pending = await call('POST', `/challenges/${challenge.id}/answer`, { kind: 'decoupled' });
    expect(pending.json).toMatchObject({ status: 'open', challenge: { kind: 'decoupled' } });
    nowMs += challenge.pollAfterMs + 500;
    const done = await call('POST', `/challenges/${challenge.id}/answer`, { kind: 'decoupled' });
    expect(done.json).toEqual({ status: 'completed' });

    // accounts discovered, user-present sync ingests
    await app.ctx.sync.idle();
    const [conn] = await database.db
      .select()
      .from(connectors)
      .where(eq(connectors.id, connectorId));
    expect(conn?.status).toBe('ok');
    const accs = await database.db
      .select()
      .from(accounts)
      .where(eq(accounts.connectorId, connectorId));
    expect(accs).toHaveLength(1);

    const list = await call('GET', '/transactions');
    expect(list.json['transactions']).toHaveLength(2);
    const groceries = (
      await database.db.select().from(categories).where(eq(categories.householdId, householdId))
    ).find((c) => c.name === 'Groceries');
    expect(groceries).toBeDefined();
    for (const t of list.json['transactions'] as Json[]) {
      expect(t['categoryId']).toBe(groceries?.id);
      expect(t['currency']).toBe('EUR');
    }
    expect((list.json['transactions'] as Json[]).map((t) => t['amountMinor']).sort()).toEqual([
      '-2345',
      '-890',
    ]);
    // these extra GETs only feed the response bodies into the leak scan below
    await call('GET', '/connectors');
    await call('GET', '/accounts');

    // later scheduled run: the bank now demands a TAN for statements
    port.scenario.statementsRequireTan = true;
    nowMs += 6 * 60 * 60 * 1000;
    const result = await runSync(
      {
        db: database.db,
        keyring,
        registry: app.ctx.registry,
        logger,
        now,
        onIngested: async () => {},
      },
      connectorId,
      'schedule',
    );
    expect(result.outcome).toBe('needs_attention');
    const [after] = await database.db
      .select()
      .from(connectors)
      .where(eq(connectors.id, connectorId));
    expect(after?.status).toBe('needs_attention');
    const notes = await database.db.select().from(notifications);
    const attention = notes.filter((n) => n.kind === 'connector_attention');
    expect(attention).toHaveLength(1);
    expect(attention[0]?.memberId).toBe(ownerId);

    // canaries: nothing the user typed leaks into storage, responses or logs
    const dump = await database.dumpData();
    expect(dump).toContain('COPY public.connectors'); // sanity: the dump really contains the data
    const logs = logLines.join('\n');
    expect(logs.length).toBeGreaterThan(0);
    const responses = bodies.join('\n');
    for (const canary of [PIN, USER]) {
      const hex = Buffer.from(canary, 'utf8').toString('hex');
      expect(dump, `dump has ${canary}`).not.toContain(canary);
      expect(dump.toLowerCase(), `dump has hex of ${canary}`).not.toContain(hex);
      expect(responses, `responses have ${canary}`).not.toContain(canary);
      expect(logs, `logs have ${canary}`).not.toContain(canary);
    }
  }, 60_000);
});

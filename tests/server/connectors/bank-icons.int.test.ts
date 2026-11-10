import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '@budgedino/server/app';
import {
  createBankIconService,
  createDbBankIconStore,
} from '@budgedino/server/connectors/bank-icons';
import { Keyring } from '@budgedino/server/households/keyring';
import { createLogger } from '@budgedino/server/observability/logger';
import {
  createHousehold,
  createTestMember,
  createTestSession,
  randomMasterKey,
} from '../../support/factories.js';
import { startTestDatabase, type TestDatabase } from '../../support/postgres.js';

const PNG = Buffer.from('89504e470d0a1a0a0000', 'hex');

let database: TestDatabase;
let app: FastifyInstance;
let token: string;
let fetchImpl: ReturnType<typeof vi.fn>;

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
  fetchImpl = vi.fn(
    async () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } }),
  );
  const master = randomMasterKey();
  const keyring = new Keyring(database.db, master);
  const logger = createLogger({ level: 'silent' });
  app = buildApp({
    db: database.db,
    keyring,
    master,
    logger,
    bankIcons: createBankIconService({
      store: createDbBankIconStore(database.db),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger,
      now: () => new Date(),
    }),
  });
  await app.ready();
  const householdId = await createHousehold(database.db, keyring);
  const memberId = await createTestMember(database.db, keyring, householdId);
  token = await createTestSession(database.db, keyring, householdId, memberId);
});

const get = (bank: string, auth = true) =>
  app.inject({
    method: 'GET',
    url: `/api/v1/banks/${bank}/icon`,
    ...(auth ? { headers: { authorization: `Bearer ${token}` } } : {}),
  });

describe('GET /banks/:bank/icon', () => {
  it('requires authentication', async () => {
    expect((await get('dkb', false)).statusCode).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('serves the image with cache headers and caches it in the database', async () => {
    const res = await get('dkb');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toBe('private, max-age=86400');
    expect(res.rawPayload.equals(PNG)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe('https://www.dkb.de/apple-touch-icon.png');

    const again = await get('dkb');
    expect(again.statusCode).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // from the DB cache
    const { rows } = await database.pool.query<{ bank: string }>('select bank from bank_icons');
    expect(rows).toEqual([{ bank: 'dkb' }]);
  });

  it('answers 404 for unknown banks, the demo bank and failed fetches', async () => {
    expect((await get('unknown')).statusCode).toBe(404);
    expect((await get('fake')).statusCode).toBe(404);
    expect((await get(encodeURIComponent('http://evil.example/'))).statusCode).toBe(404);
    expect(fetchImpl).not.toHaveBeenCalled();
    fetchImpl.mockResolvedValueOnce(new Response('x', { status: 500 }));
    expect((await get('comdirect')).statusCode).toBe(404);
  });
});

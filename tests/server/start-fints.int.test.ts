import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@budgedino/server/config';
import { start } from '@budgedino/server/main';
import { createLogger } from '@budgedino/server/observability/logger';
import { startTestDatabase, type TestDatabase } from '../support/postgres.js';
import { ScriptedFinTSPort } from '../support/fints/scripted-port';

let database: TestDatabase;
beforeAll(async () => {
  database = await startTestDatabase();
}, 120_000);
afterAll(async () => {
  await database.stop();
});

const baseEnv = () => ({
  DATABASE_URL: database.container.getConnectionUri(),
  BUDGEDINO_MASTER_KEY: randomBytes(32).toString('base64'),
  NODE_ENV: 'test',
});

const quiet = () => createLogger({ level: 'silent' });

describe('start() with the fints connector', () => {
  it('registers fints when enabled with a product id, and stops cleanly', async () => {
    const config = loadConfig({
      ...baseEnv(),
      BUDGEDINO_CONNECTORS: 'fints',
      BUDGEDINO_FINTS_PRODUCT_ID: 'TESTPRODUCT',
    });
    const server = await start(
      { ...config, port: 0, host: '127.0.0.1' },
      { logger: quiet(), pollingIntervalSeconds: 0.5, fintsPort: new ScriptedFinTSPort({}) },
    );
    try {
      expect(server.connectorTypes).toEqual(['fints']);
    } finally {
      await server.stop();
    }
  });

  it('does not register fints when it is not enabled', async () => {
    const config = loadConfig({ ...baseEnv(), BUDGEDINO_CONNECTORS: 'fake' });
    const server = await start(
      { ...config, port: 0, host: '127.0.0.1' },
      { logger: quiet(), pollingIntervalSeconds: 0.5 },
    );
    try {
      expect(server.connectorTypes).toEqual(['fake']);
    } finally {
      await server.stop();
    }
  });

  it('rejects fints without a product id', () => {
    expect(() => loadConfig({ ...baseEnv(), BUDGEDINO_CONNECTORS: 'fints' })).toThrow(
      /BUDGEDINO_FINTS_PRODUCT_ID/,
    );
  });
});

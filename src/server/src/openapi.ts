import { randomBytes } from 'node:crypto';
import { buildApp } from './app.js';
import { loadMasterKey } from './crypto/index.js';
import type { Db } from './db/client.js';
import { Keyring } from './households/keyring.js';
import { createLogger } from './observability/logger.js';

/**
 * The OpenAPI document of the API, generated from the route schemas. Building the app does not touch the
 * database, so a stub handle and a throwaway key are enough; no connection is made.
 */
export async function generateOpenApi(): Promise<unknown> {
  const db = {} as Db;
  const master = loadMasterKey({ BUDGEDINO_MASTER_KEY: randomBytes(32).toString('base64') });
  const app = buildApp({
    db,
    keyring: new Keyring(db, master),
    master,
    logger: createLogger({ level: 'silent' }),
  });
  try {
    await app.ready();
    return app.swagger();
  } finally {
    await app.close();
  }
}

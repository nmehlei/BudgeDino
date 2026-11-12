import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { Logger } from '../observability/logger.js';
import { safeErrorInfo } from '../observability/redact.js';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema> & { $client: pg.Pool };

/** A database handle or an open transaction on it. */
export type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

export interface DbHandle {
  db: Db;
  pool: pg.Pool;
  close(): Promise<void>;
}

/** Waiting for a free pool connection fails after this long instead of hanging forever. */
const CONNECTION_TIMEOUT_MS = 10_000;

/**
 * node-postgres emits `error` on the pool when an idle client dies (e.g. 57P01 on a database restart); without
 * a listener that is an uncaught exception and the process exits. Log it (no query text or parameters) and
 * keep running: the pool drops the dead client and connects anew once the database is back.
 */
export function attachPoolErrorHandler(pool: pg.Pool, logger?: Logger): void {
  pool.on('error', (err) => {
    logger?.error({ error: safeErrorInfo(err) }, 'database pool: idle client error');
  });
}

export function createDb(connectionString: string, logger?: Logger): DbHandle {
  const pool = new pg.Pool({ connectionString, connectionTimeoutMillis: CONNECTION_TIMEOUT_MS });
  attachPoolErrorHandler(pool, logger);
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}

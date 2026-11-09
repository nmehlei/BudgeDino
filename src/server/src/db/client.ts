import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
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

export function createDb(connectionString: string): DbHandle {
  const pool = new pg.Pool({ connectionString, connectionTimeoutMillis: CONNECTION_TIMEOUT_MS });
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}

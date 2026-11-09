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

export function createDb(connectionString: string): DbHandle {
  const pool = new pg.Pool({ connectionString });
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}

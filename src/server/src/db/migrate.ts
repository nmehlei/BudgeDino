import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate as drizzleMigrate } from 'drizzle-orm/node-postgres/migrator';
import type pg from 'pg';
import * as schema from './schema.js';

/** Arbitrary constant identifying the BudgeDino migration lock. */
const MIGRATION_LOCK_KEY = 0x42444d49;

/** `src/server/drizzle` seen from the sources (`src/db`) and from the bundle (`dist`). */
const MIGRATIONS_FOLDER = [
  fileURLToPath(new URL('../../drizzle', import.meta.url)),
  fileURLToPath(new URL('../drizzle', import.meta.url)),
].find((dir) => existsSync(dir)) as string;

/**
 * Applies pending migrations. Serialised across processes with a session-level advisory lock so that
 * several server instances starting at once do not race.
 */
export async function migrate(pool: pg.Pool, migrationsFolder = MIGRATIONS_FOLDER): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      await drizzleMigrate(drizzle(client, { schema }), { migrationsFolder });
    } finally {
      await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

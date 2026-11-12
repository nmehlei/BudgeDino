import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, type DbHandle } from '@budgedino/server/db/client';
import { migrate } from '@budgedino/server/db/migrate';

export interface TestDatabase extends DbHandle {
  container: StartedPostgreSqlContainer;
  /** Truncates every table (except the migration bookkeeping) for a clean slate per test. */
  reset(): Promise<void>;
  /** Runs `pg_dump --data-only` inside the container and returns the raw SQL text. */
  dumpData(): Promise<string>;
  stop(): Promise<void>;
}

const POSTGRES_IMAGE = 'postgres:18';

/** Starts a throwaway PostgreSQL container, applies all migrations and returns helpers. */
export async function startTestDatabase(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  const handle = createDb(container.getConnectionUri());
  await migrate(handle.pool);

  return {
    ...handle,
    container,
    async reset() {
      const { rows } = await handle.pool.query<{ tablename: string }>(
        `select tablename from pg_tables where schemaname = 'public'`,
      );
      if (rows.length === 0) return;
      const tables = rows.map((r) => `"public"."${r.tablename}"`).join(', ');
      await handle.pool.query(`truncate table ${tables} restart identity cascade`);
    },
    async dumpData() {
      const result = await container.exec([
        'pg_dump',
        '--data-only',
        '-U',
        container.getUsername(),
        container.getDatabase(),
      ]);
      if (result.exitCode !== 0) {
        throw new Error(`pg_dump failed with exit code ${result.exitCode}`);
      }
      return result.output;
    },
    async stop() {
      await handle.close();
      await container.stop();
    },
  };
}

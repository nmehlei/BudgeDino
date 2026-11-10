import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@budgedino/server/db/client';
import { createLogger } from '@budgedino/server/observability/logger';
import { withConnectorLock } from '@budgedino/server/sync/run';

function stubDb(query: (sql: string) => Promise<unknown>) {
  const release = vi.fn();
  const client = Object.assign(new EventEmitter(), { query: vi.fn(query), release });
  const db = { $client: { connect: async () => client } } as unknown as Db;
  return { db, client, release };
}
const logger = createLogger({ level: 'silent' });

describe('withConnectorLock', () => {
  it('returns the connection to the pool after a clean unlock', async () => {
    const { db, release } = stubDb(async () => ({}));
    const out = await withConnectorLock({ db, logger }, 'c1', async () => 42);
    expect(out).toBe(42);
    expect(release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('destroys the connection when pg_advisory_unlock fails, and still returns the result', async () => {
    const { db, release } = stubDb(async (sql) => {
      if (sql.includes('unlock')) throw new Error('connection reset');
      return {};
    });
    const out = await withConnectorLock({ db, logger }, 'c1', async () => 'done');
    expect(out).toBe('done');
    expect(release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('survives a database error event while the lock is held (restart mid-sync) and destroys the connection', async () => {
    const { db, client, release } = stubDb(async () => ({}));
    const out = await withConnectorLock({ db, logger }, 'c1', async () => {
      // pg emits 'error' on a checked-out client with no active query; without a listener this throws.
      expect(() =>
        client.emit('error', new Error('terminating connection due to administrator command')),
      ).not.toThrow();
      return 'finished';
    });
    expect(out).toBe('finished');
    expect(release).toHaveBeenCalledExactlyOnceWith(true);
    expect(client.listenerCount('error')).toBe(0);
  });

  it('destroys the connection when taking the lock fails', async () => {
    const { db, release } = stubDb(async () => {
      throw new Error('lock failed');
    });
    await expect(withConnectorLock({ db, logger }, 'c1', async () => 1)).rejects.toThrow();
    expect(release).toHaveBeenCalledExactlyOnceWith(true);
  });
});

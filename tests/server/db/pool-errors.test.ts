import { describe, expect, it, vi } from 'vitest';
import { createDb } from '@budgedino/server/db/client';
import type { Logger } from '@budgedino/server/observability/logger';

// The pool connects lazily, so no database is needed to emit an idle-client error on it.
describe('database pool errors', () => {
  it('logs an idle client error (57P01) without throwing and without the message', async () => {
    const error = vi.fn();
    const handle = createDb('postgres://localhost/none', { error } as unknown as Logger);
    const err = Object.assign(new Error('terminating connection; secret-value'), {
      code: '57P01',
    });
    expect(() => handle.pool.emit('error', err)).not.toThrow();
    expect(error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(error.mock.calls[0])).not.toContain('secret-value');
    expect(JSON.stringify(error.mock.calls[0])).toContain('57P01');
    await handle.close();
  });

  it('does not throw without a logger either', async () => {
    const handle = createDb('postgres://localhost/none');
    expect(() => handle.pool.emit('error', new Error('x'))).not.toThrow();
    await handle.close();
  });
});

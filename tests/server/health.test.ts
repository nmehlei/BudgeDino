import { describe, expect, it } from 'vitest';
import { buildApp } from '@budgedino/server/app';
import { SERVER_VERSION } from '@budgedino/server/build-info';
import { createLogger } from '@budgedino/server/observability/logger';

describe('GET /api/v1/health', () => {
  it('is public, needs no database and reports the version', async () => {
    // The route touches no dependency, so inert stand-ins are enough (no Postgres needed).
    const app = buildApp({
      db: {} as never,
      keyring: {} as never,
      master: {} as never,
      logger: createLogger({ level: 'silent' }),
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, version: SERVER_VERSION });
      const entry = app.routeRegistry.find((r) => r.url === '/api/v1/health');
      expect(entry?.access).toBe('public');
    } finally {
      await app.close();
    }
  });
});

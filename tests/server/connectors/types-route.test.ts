import { describe, expect, it, vi } from 'vitest';
import { connectorTypesResponse } from '@budgedino/shared';
import { buildApp } from '@budgedino/server/app';
import { createConnectorRegistry } from '@budgedino/server/connectors/registry';
import { createFakeConnector } from '@budgedino/server/connectors/fake/fake-connector';
import { createLogger } from '@budgedino/server/observability/logger';

// The guard looks the session up in Postgres; stub just that lookup so the real route runs without Docker.
vi.mock('@budgedino/server/auth/sessions', async (orig) => ({
  ...(await orig<object>()),
  authenticateSession: async () => ({
    memberId: 'm1',
    householdId: 'h1',
    role: 'member',
    sessionId: 's1',
  }),
}));

const TOKEN = 'A'.repeat(43);

describe('GET /api/v1/connectors/types', () => {
  const build = (registry?: ReturnType<typeof createConnectorRegistry>) =>
    buildApp({
      db: {} as never,
      keyring: {} as never,
      master: {} as never,
      logger: createLogger({ level: 'silent' }),
      ...(registry ? { registry } : {}),
    });

  it('is a member route, rejects anonymous callers and lists the enabled types', async () => {
    const app = build(createConnectorRegistry([createFakeConnector()]));
    try {
      await app.ready();
      const entry = app.routeRegistry.find(
        (r) => r.url === '/api/v1/connectors/types' && r.method === 'GET',
      );
      expect(entry?.access).toBe('member');
      const anonymous = await app.inject({ method: 'GET', url: '/api/v1/connectors/types' });
      expect(anonymous.statusCode).toBe(401);
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/connectors/types',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(connectorTypesResponse.parse(res.json())).toEqual({ types: ['fake'] });
      expect(connectorTypesResponse.parse({ types: app.ctx.registry.types() })).toEqual({
        types: ['fake'],
      });
    } finally {
      await app.close();
    }
  });

  it('lists nothing when no connector is enabled', async () => {
    const app = build();
    try {
      expect(app.ctx.registry.types()).toEqual([]);
    } finally {
      await app.close();
    }
  });
});

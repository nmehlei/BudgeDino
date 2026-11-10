import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { healthResponse, VERSION } from '@budgedino/shared';

/** `GET /health`: public liveness probe. Touches no database and returns no household data. */
export function healthRoutes(app: FastifyInstance): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get(
    '/health',
    {
      config: { access: 'public' },
      schema: { tags: ['health'], response: { 200: healthResponse } },
    },
    () => ({ ok: true as const, version: VERSION }),
  );
}

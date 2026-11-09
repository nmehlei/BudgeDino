import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { createInviteRequest, createInviteResponse, errorResponse } from '@budgedino/shared';
import { adminGuard } from '../auth/guard.js';
import { createInvite } from './invites.js';

export function householdRoutes(app: FastifyInstance): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    '/households/invites',
    {
      config: { access: 'admin' },
      preHandler: adminGuard,
      schema: {
        tags: ['households'],
        security: [{ bearer: [] }],
        body: createInviteRequest,
        response: { 201: createInviteResponse, '4xx': errorResponse },
      },
    },
    async (req, reply) => {
      const auth = req.auth;
      if (!auth) throw new Error('unreachable: adminGuard authenticates');
      const { db, now } = app.ctx;
      const invite = await createInvite(db, {
        householdId: auth.householdId,
        role: req.body.role,
        now: now(),
      });
      return reply
        .code(201)
        .send({ inviteToken: invite.token, expiresAt: invite.expiresAt.toISOString() });
    },
  );
}

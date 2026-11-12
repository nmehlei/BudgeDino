import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  createInviteRequest,
  createInviteResponse,
  errorResponse,
  inviteIdParams,
  invitesResponse,
  membersResponse,
} from '@budgedino/shared';
import type { AuthContext } from '../deps.js';
import { members } from '../db/schema.js';
import { HttpError } from '../http/errors.js';
import { decryptMemberDisplayName, decryptMemberEmail } from '../repositories/members.js';
import { createInvite, listPendingInvites, revokeInvite } from './invites.js';

const security = [{ bearer: [] }];

function authOf(req: { auth: AuthContext | null }): AuthContext {
  if (!req.auth) throw new Error('unreachable: the access hook authenticates');
  return req.auth;
}

export function householdRoutes(app: FastifyInstance): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/households/members',
    {
      config: { access: 'member' },
      schema: {
        tags: ['households'],
        security,
        response: { 200: membersResponse, '4xx': errorResponse },
      },
    },
    async (req) => {
      const auth = authOf(req);
      const { db, keyring } = app.ctx;
      const dk = await keyring.forHousehold(auth.householdId);
      const rows = await db
        .select()
        .from(members)
        .where(eq(members.householdId, auth.householdId))
        .orderBy(asc(members.createdAt), asc(members.id));
      return {
        members: rows.map((m) => ({
          id: m.id,
          displayName: decryptMemberDisplayName(dk, m.id, m.displayNameEnc),
          role: m.role,
          joinedAt: m.createdAt.toISOString(),
          isSelf: m.id === auth.memberId,
          disabled: m.disabledAt !== null,
          ...(auth.role === 'admin' ? { email: decryptMemberEmail(dk, m.id, m.emailEnc) } : {}),
        })),
      };
    },
  );

  r.get(
    '/households/invites',
    {
      config: { access: 'admin' },
      schema: {
        tags: ['households'],
        security,
        response: { 200: invitesResponse, '4xx': errorResponse },
      },
    },
    async (req) => {
      const auth = authOf(req);
      const { db, now } = app.ctx;
      const rows = await listPendingInvites(db, auth.householdId, now());
      return {
        invites: rows.map((i) => ({
          id: i.id,
          role: i.role,
          expiresAt: i.expiresAt.toISOString(),
        })),
      };
    },
  );

  r.delete(
    '/households/invites/:id',
    {
      config: { access: 'admin' },
      schema: {
        tags: ['households'],
        security,
        params: inviteIdParams,
        response: { 204: z.null(), '4xx': errorResponse },
      },
    },
    async (req, reply) => {
      const auth = authOf(req);
      const { db, now } = app.ctx;
      const result = await revokeInvite(db, auth.householdId, req.params.id, now());
      if (result === 'used') {
        throw new HttpError(409, 'invite_used', 'This invitation was already used');
      }
      if (result === 'not_found') {
        throw new HttpError(404, 'not_found', 'Invitation not found');
      }
      return reply.code(204).send(null);
    },
  );

  r.post(
    '/households/invites',
    {
      config: { access: 'admin' },
      schema: {
        tags: ['households'],
        security,
        body: createInviteRequest,
        response: { 201: createInviteResponse, '4xx': errorResponse },
      },
    },
    async (req, reply) => {
      const auth = authOf(req);
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

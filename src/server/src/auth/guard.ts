import type { FastifyRequest } from 'fastify';
import type { AuthContext } from '../deps.js';
import { forbidden, unauthorized } from '../http/errors.js';
import { authenticateSession } from './sessions.js';

const BEARER = /^Bearer ([A-Za-z0-9_-]{43})$/;

/**
 * Authenticates the request from `Authorization: Bearer <session token>`. Throws the same 401 for
 * missing, malformed, unknown, revoked and disabled-member credentials. Caches the result on the request.
 */
export async function requireMember(req: FastifyRequest): Promise<AuthContext> {
  if (req.auth) return req.auth;
  const token = BEARER.exec(req.headers.authorization ?? '')?.[1];
  if (!token) throw unauthorized();
  const { db, now } = req.server.ctx;
  const auth = await authenticateSession(db, token, now());
  if (!auth) throw unauthorized();
  req.auth = auth;
  return auth;
}

export async function requireAdmin(req: FastifyRequest): Promise<AuthContext> {
  const auth = await requireMember(req);
  if (auth.role !== 'admin') throw forbidden();
  return auth;
}

/** Fastify `preHandler` hooks for `config: { access: 'member' | 'admin' }` routes. */
export async function memberGuard(req: FastifyRequest): Promise<void> {
  await requireMember(req);
}
export async function adminGuard(req: FastifyRequest): Promise<void> {
  await requireAdmin(req);
}

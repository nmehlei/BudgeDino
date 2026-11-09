import { and, eq, isNull, lt, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  errorResponse,
  loginRequest,
  registerConfirmRequest,
  registerRequest,
  registerResponse,
  sessionIdParams,
  sessionListResponse,
  sessionResponse,
} from '@budgedino/shared';
import { members } from '../db/schema.js';
import { HttpError, invalidCredentials, inviteInvalid } from '../http/errors.js';
import { findValidInvite, consumeInvite } from '../households/invites.js';
import { createMember, decryptTotpSecret, normalizeEmail } from '../repositories/members.js';
import { hashPassword, verifyAgainstDummy, verifyPassword } from './passwords.js';
import { createSession, listSessions, revokeSession } from './sessions.js';
import { hashToken } from './tokens.js';
import { generateTotpSecret, totpProvisioningUri, verifyTotp } from './totp.js';

const PG_UNIQUE_VIOLATION = '23505';

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  return e?.code === PG_UNIQUE_VIOLATION || e?.cause?.code === PG_UNIQUE_VIOLATION;
}

export function authRoutes(app: FastifyInstance): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const security = [{ bearer: [] }];

  r.post(
    '/auth/register',
    {
      config: { access: 'public' },
      schema: {
        tags: ['auth'],
        body: registerRequest,
        response: { 200: registerResponse, '4xx': errorResponse },
      },
    },
    async (req) => {
      const { db, keyring, now, pendingRegistrations } = app.ctx;
      const body = req.body;
      const inviteTokenHash = hashToken(body.inviteToken);
      // Cheap checks first: no argon2 work for callers without a valid invite.
      const invite = await findValidInvite(db, inviteTokenHash, now());
      if (!invite) throw inviteInvalid();

      const emailBidx = keyring.emailIndex(body.email);
      const [existing] = await db
        .select({ id: members.id })
        .from(members)
        .where(eq(members.emailBidx, emailBidx));
      if (existing) {
        throw new HttpError(409, 'email_unavailable', 'This email address cannot be used');
      }

      const totpSecret = generateTotpSecret();
      const pendingId = await pendingRegistrations.create(
        {
          inviteTokenHash,
          householdId: invite.householdId,
          role: invite.role,
          email: body.email.trim(),
          emailBidx,
          displayName: body.displayName,
          deviceName: body.deviceName,
          passwordHash: await hashPassword(body.password),
          totpSecret,
        },
        now().getTime(),
      );
      return {
        totpProvisioningUri: totpProvisioningUri(totpSecret, normalizeEmail(body.email)),
        pendingId,
      };
    },
  );

  r.post(
    '/auth/register/confirm',
    {
      config: { access: 'public' },
      schema: {
        tags: ['auth'],
        body: registerConfirmRequest,
        response: { 200: sessionResponse, '4xx': errorResponse },
      },
    },
    async (req) => {
      const { db, keyring, now, pendingRegistrations } = app.ctx;
      const at = now();
      const pending = await pendingRegistrations.get(req.body.pendingId, at.getTime());
      if (!pending) {
        throw new HttpError(410, 'registration_expired', 'This registration has expired');
      }
      const totp = verifyTotp(pending.totpSecret, req.body.totpCode, at.getTime());
      if (!totp.valid) {
        await pendingRegistrations.recordFailure(pending.id);
        throw new HttpError(401, 'invalid_code', 'Invalid code');
      }

      let token: string;
      try {
        token = await db.transaction(async (tx) => {
          // Re-check and consume in one statement: of two concurrent confirmations one wins.
          const invite = await consumeInvite(tx, pending.inviteTokenHash, at);
          if (!invite) throw inviteInvalid();
          const dk = await keyring.forHousehold(invite.householdId);
          const memberId = await createMember(tx, dk, {
            householdId: invite.householdId,
            role: invite.role,
            email: pending.email,
            emailBidx: pending.emailBidx,
            displayName: pending.displayName,
            passwordHash: pending.passwordHash,
            totpSecret: pending.totpSecret,
            totpLastStep: totp.step,
          });
          const session = await createSession(tx, keyring, {
            memberId,
            householdId: invite.householdId,
            deviceName: pending.deviceName,
            now: at,
          });
          return session.token;
        });
      } catch (err) {
        if (err instanceof HttpError) {
          await pendingRegistrations.delete(pending.id);
          throw err;
        }
        if (isUniqueViolation(err)) {
          await pendingRegistrations.delete(pending.id);
          throw new HttpError(409, 'email_unavailable', 'This email address cannot be used');
        }
        throw err;
      }
      await pendingRegistrations.delete(pending.id);
      return { sessionToken: token };
    },
  );

  r.post(
    '/auth/login',
    {
      config: { access: 'public' },
      schema: {
        tags: ['auth'],
        body: loginRequest,
        response: { 200: sessionResponse, '4xx': errorResponse },
      },
    },
    async (req, reply) => {
      const { db, keyring, now, loginEmailLimiter, loginIpLimiter } = app.ctx;
      const body = req.body;
      const emailKey = keyring.blindIndex('login-rate-limit', normalizeEmail(body.email));
      const ipKey = req.ip;

      // Count the attempt before any verification so parallel requests cannot all pass the check.
      const email = await loginEmailLimiter.hit(emailKey);
      const ip = await loginIpLimiter.hit(ipKey);
      if (loginEmailLimiter.isOver(email) || loginIpLimiter.isOver(ip)) {
        const wait = loginEmailLimiter.isOver(email)
          ? await loginEmailLimiter.retryAfterSeconds(emailKey)
          : await loginIpLimiter.retryAfterSeconds(ipKey);
        void reply.header('retry-after', String(wait));
        throw new HttpError(429, 'too_many_attempts', 'Too many failed attempts, try again later');
      }

      const at = now();
      const [member] = await db
        .select()
        .from(members)
        .where(eq(members.emailBidx, keyring.emailIndex(body.email)));

      // Always one argon2 verification, whether or not the member exists.
      const passwordOk =
        member && !member.disabledAt
          ? await verifyPassword(member.passwordHash, body.password)
          : await verifyAgainstDummy(body.password);

      let sessionToken: string | null = null;
      if (member && passwordOk && member.totpSecretEnc) {
        const dk = await keyring.forHousehold(member.householdId);
        const secret = decryptTotpSecret(dk, member.id, member.totpSecretEnc);
        const totp = verifyTotp(secret, body.totpCode ?? '', at.getTime());
        if (totp.valid) {
          // Atomic replay guard: only a step later than the last used one can claim the member.
          const claimed = await db
            .update(members)
            .set({ totpLastStep: totp.step })
            .where(
              and(
                eq(members.id, member.id),
                or(isNull(members.totpLastStep), lt(members.totpLastStep, totp.step)),
              ),
            )
            .returning({ id: members.id });
          if (claimed.length > 0) {
            sessionToken = (
              await createSession(db, keyring, {
                memberId: member.id,
                householdId: member.householdId,
                deviceName: body.deviceName,
                now: at,
              })
            ).token;
          }
        }
      }

      if (!sessionToken) throw invalidCredentials();
      await loginEmailLimiter.reset(emailKey);
      await loginIpLimiter.release(ipKey);
      return { sessionToken };
    },
  );

  r.get(
    '/auth/sessions',
    {
      config: { access: 'member' },
      schema: {
        tags: ['auth'],
        security,
        response: { 200: sessionListResponse, '4xx': errorResponse },
      },
    },
    async (req) => {
      const auth = req.auth;
      if (!auth) throw new Error('unreachable: the access hook authenticates');
      const list = await listSessions(app.ctx.db, app.ctx.keyring, auth);
      return {
        sessions: list.map((s) => ({
          id: s.id,
          deviceName: s.deviceName,
          createdAt: s.createdAt.toISOString(),
          lastSeenAt: s.lastSeenAt?.toISOString() ?? null,
          current: s.current,
        })),
      };
    },
  );

  r.delete(
    '/auth/sessions/:id',
    {
      config: { access: 'member' },
      schema: {
        tags: ['auth'],
        security,
        params: sessionIdParams,
        response: { 204: z.null(), '4xx': errorResponse },
      },
    },
    async (req, reply) => {
      const auth = req.auth;
      if (!auth) throw new Error('unreachable: the access hook authenticates');
      const revoked = await revokeSession(app.ctx.db, auth, req.params.id, app.ctx.now());
      if (!revoked) throw new HttpError(404, 'not_found', 'Session not found');
      return reply.code(204).send(null);
    },
  );
}

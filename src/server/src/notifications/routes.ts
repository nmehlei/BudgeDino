import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  ackNotificationsRequest,
  ackNotificationsResponse,
  errorResponse,
  notificationsQuery,
  notificationsResponse,
} from '@budgedino/shared';
import { decryptString } from '../crypto/index.js';
import { notifications } from '../db/schema.js';

/** `created_at` at the precision the cursor carries (JS dates have milliseconds, PostgreSQL microseconds). */
const createdMs = sql`date_trunc('milliseconds', ${notifications.createdAt})`;

/**
 * Notification polling (no push service in v1): the app fetches its own pending notifications and
 * acknowledges them. Keyset cursor = `<createdAt ISO>|<id>`, ordered oldest first.
 */
export function notificationRoutes(app: FastifyInstance): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const security = [{ bearer: [] }];

  r.get(
    '/notifications',
    {
      config: { access: 'member' },
      schema: {
        tags: ['notifications'],
        security,
        querystring: notificationsQuery,
        response: { 200: notificationsResponse, '4xx': errorResponse },
      },
    },
    async (req) => {
      const auth = req.auth;
      if (!auth) throw new Error('unreachable: the access hook authenticates');
      const { db, keyring } = app.ctx;
      const { since, limit } = req.query;
      const conds = [eq(notifications.memberId, auth.memberId), isNull(notifications.deliveredAt)];
      if (since !== undefined) {
        const [at, id] = since.split('|') as [string, string];
        conds.push(sql`(${createdMs}, ${notifications.id}) > (${at}::timestamptz, ${id}::uuid)`);
      }
      const rows = await db
        .select()
        .from(notifications)
        .where(and(...conds))
        .orderBy(asc(createdMs), asc(notifications.id))
        .limit(limit);
      const dk = await keyring.forHousehold(auth.householdId);
      const last = rows[rows.length - 1];
      return {
        notifications: rows.map((n) => ({
          id: n.id,
          kind: n.kind,
          body: n.bodyEnc
            ? decryptString(dk, n.bodyEnc, { table: 'notifications', column: 'body', rowId: n.id })
            : null,
          createdAt: n.createdAt.toISOString(),
        })),
        nextCursor: last ? `${last.createdAt.toISOString()}|${last.id}` : (since ?? null),
      };
    },
  );

  r.post(
    '/notifications/ack',
    {
      config: { access: 'member' },
      schema: {
        tags: ['notifications'],
        security,
        body: ackNotificationsRequest,
        response: { 200: ackNotificationsResponse, '4xx': errorResponse },
      },
    },
    async (req) => {
      const auth = req.auth;
      if (!auth) throw new Error('unreachable: the access hook authenticates');
      // Only the caller's own ids; anything else is ignored silently (no oracle for other members' ids).
      const updated = await app.ctx.db
        .update(notifications)
        .set({ deliveredAt: app.ctx.now() })
        .where(
          and(
            inArray(notifications.id, req.body.ids),
            eq(notifications.memberId, auth.memberId),
            isNull(notifications.deliveredAt),
          ),
        )
        .returning({ id: notifications.id });
      return { acked: updated.length };
    },
  );
}

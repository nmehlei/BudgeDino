import { and, eq, exists, ne, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  connectorIdParams,
  connectorListResponse,
  errorResponse,
  syncStartedResponse,
  type ConnectorInfo,
} from '@budgedino/shared';
import type { ConnectorRegistry } from '../connectors/registry.js';
import type { Db } from '../db/client.js';
import type { Keyring } from '../households/keyring.js';
import { decryptDisplayName } from '../repositories/connectors.js';
import { accounts, connectors } from '../db/schema.js';
import type { AuthContext } from '../deps.js';
import { HttpError } from '../http/errors.js';

const iso = (d: Date | null) => (d === null ? null : d.toISOString());

/**
 * Connectors the caller may see: their own in full, plus others' connectors that back at least one
 * household-visible account (id, type, status, lastSuccessAt only). Shared with `GET /home`.
 */
export async function listConnectorInfos(
  db: Db,
  keyring: Keyring,
  registry: ConnectorRegistry,
  auth: Pick<AuthContext, 'memberId' | 'householdId'>,
): Promise<ConnectorInfo[]> {
  // Own connectors, plus others' connectors that back at least one household-visible account.
  const rows = await db
    .select()
    .from(connectors)
    .where(
      and(
        eq(connectors.householdId, auth.householdId),
        or(
          eq(connectors.ownerMemberId, auth.memberId),
          exists(
            db
              .select({ one: accounts.id })
              .from(accounts)
              .where(
                and(
                  eq(accounts.connectorId, connectors.id),
                  eq(accounts.visibility, 'household'),
                  ne(accounts.ownerMemberId, auth.memberId),
                ),
              ),
          ),
        ),
      ),
    )
    .orderBy(connectors.createdAt, connectors.id);
  const dk = await keyring.forHousehold(auth.householdId);
  const experimental = (type: string) => {
    try {
      return registry.get(type).experimental;
    } catch {
      return false;
    }
  };
  return rows.map((c) =>
    c.ownerMemberId === auth.memberId
      ? {
          id: c.id,
          type: c.type,
          status: c.status,
          isOwner: true,
          bank: c.bank ?? c.type,
          displayName: decryptDisplayName(dk, c.id, c.displayNameEnc),
          experimental: experimental(c.type),
          lastSuccessAt: iso(c.lastSuccessAt),
          lastErrorCode: c.lastErrorCode,
          consentExpiresAt: iso(c.consentExpiresAt),
        }
      : {
          id: c.id,
          type: c.type,
          status: c.status,
          isOwner: false,
          bank: c.bank ?? c.type,
          lastSuccessAt: iso(c.lastSuccessAt),
        },
  );
}

export function syncRoutes(app: FastifyInstance): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const security = [{ bearer: [] }];

  r.get(
    '/connectors',
    {
      config: { access: 'member' },
      schema: {
        tags: ['connectors'],
        security,
        response: { 200: connectorListResponse, '4xx': errorResponse },
      },
    },
    async (req) => {
      const auth = req.auth;
      if (!auth) throw new Error('unreachable: the access hook authenticates');
      return {
        connectors: await listConnectorInfos(app.ctx.db, app.ctx.keyring, app.ctx.registry, auth),
      };
    },
  );

  r.post(
    '/connectors/:id/sync',
    {
      config: { access: 'member' },
      schema: {
        tags: ['connectors'],
        security,
        params: connectorIdParams,
        response: { 202: syncStartedResponse, '4xx': errorResponse },
      },
    },
    async (req, reply) => {
      const auth = req.auth;
      if (!auth) throw new Error('unreachable: the access hook authenticates');
      const { db, sync } = app.ctx;
      const [own] = await db
        .select({ id: connectors.id })
        .from(connectors)
        .where(
          and(
            eq(connectors.id, req.params.id),
            eq(connectors.ownerMemberId, auth.memberId),
            eq(connectors.householdId, auth.householdId),
          ),
        );
      // Owner only. Other members (admins included) and unknown ids get the same 404.
      if (!own) throw new HttpError(404, 'not_found', 'Connector not found');
      const runId = await sync.startUserRun(own.id, req.ip);
      return reply.code(202).send({ runId });
    },
  );
}

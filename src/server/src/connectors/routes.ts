import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  challengeAnswer,
  challengeAnswerResponse,
  challengeIdParams,
  challengeStatusResponse,
  connectStartedResponse,
  connectorIdParams,
  connectorTypesResponse,
  deleteConnectorQuery,
  ownConnectorInfo,
  renameConnectorRequest,
  createConnectorRequest,
  errorResponse,
  reconnectResponse,
} from '@budgedino/shared';
import type { AuthContext } from '../deps.js';
import { HttpError } from '../http/errors.js';
import { listConnectorInfos } from '../sync/routes.js';

function authOf(req: { auth: AuthContext | null }): AuthContext {
  if (!req.auth) throw new Error('unreachable: the access hook authenticates');
  return req.auth;
}

/**
 * Connect/reconnect and the challenge API. Everything here is user-initiated: the server never starts
 * a bank dialog on its own. Connectors and challenges belong to the member who created them; anyone else
 * (admins included) gets 404.
 */
export function connectorRoutes(app: FastifyInstance): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const security = [{ bearer: [] }];

  r.get(
    '/connectors/types',
    {
      config: { access: 'member' },
      schema: {
        tags: ['connectors'],
        security,
        response: { 200: connectorTypesResponse, '4xx': errorResponse },
      },
    },
    () => ({ types: app.ctx.registry.types() }),
  );

  r.post(
    '/connectors',
    {
      config: { access: 'member' },
      schema: {
        tags: ['connectors'],
        security,
        body: createConnectorRequest,
        response: { 200: connectStartedResponse, '4xx': errorResponse, '5xx': errorResponse },
      },
    },
    async (req) => app.ctx.challenges.connect(authOf(req), req.body, req.ip),
  );

  r.delete(
    '/connectors/:id',
    {
      config: { access: 'member' },
      schema: {
        tags: ['connectors'],
        security,
        params: connectorIdParams,
        querystring: deleteConnectorQuery,
        response: { 204: z.null(), '4xx': errorResponse },
      },
    },
    async (req, reply) => {
      await app.ctx.connectorManager.remove(authOf(req), req.params.id, req.query.mode);
      return reply.code(204).send(null);
    },
  );

  r.patch(
    '/connectors/:id',
    {
      config: { access: 'member' },
      schema: {
        tags: ['connectors'],
        security,
        params: connectorIdParams,
        body: renameConnectorRequest,
        response: { 200: ownConnectorInfo, '4xx': errorResponse },
      },
    },
    async (req) => {
      const auth = authOf(req);
      const { db, keyring, registry, connectorManager } = app.ctx;
      await connectorManager.rename(auth, req.params.id, req.body.displayName);
      const info = (await listConnectorInfos(db, keyring, registry, auth)).find(
        (c) => c.id === req.params.id,
      );
      if (info?.isOwner !== true) throw new HttpError(404, 'not_found', 'Connector not found');
      return info;
    },
  );

  r.post(
    '/connectors/:id/reconnect',
    {
      config: { access: 'member' },
      schema: {
        tags: ['connectors'],
        security,
        params: connectorIdParams,
        response: { 200: reconnectResponse, '4xx': errorResponse, '5xx': errorResponse },
      },
    },
    async (req) => app.ctx.challenges.reconnect(authOf(req), req.params.id, req.ip),
  );

  r.post(
    '/challenges/:id/answer',
    {
      config: { access: 'member' },
      schema: {
        tags: ['challenges'],
        security,
        params: challengeIdParams,
        body: challengeAnswer,
        response: { 200: challengeAnswerResponse, '4xx': errorResponse, '5xx': errorResponse },
      },
    },
    async (req) => app.ctx.challenges.answer(authOf(req), req.params.id, req.body, req.ip),
  );

  r.get(
    '/challenges/:id',
    {
      config: { access: 'member' },
      schema: {
        tags: ['challenges'],
        security,
        params: challengeIdParams,
        response: { 200: challengeStatusResponse, '4xx': errorResponse },
      },
    },
    async (req) => app.ctx.challenges.status(authOf(req), req.params.id),
  );

  r.delete(
    '/challenges/:id',
    {
      config: { access: 'member' },
      schema: {
        tags: ['challenges'],
        security,
        params: challengeIdParams,
        response: { 200: challengeStatusResponse, '4xx': errorResponse },
      },
    },
    async (req) => app.ctx.challenges.cancel(authOf(req), req.params.id),
  );
}

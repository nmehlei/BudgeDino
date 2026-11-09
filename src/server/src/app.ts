import { STATUS_CODES } from 'node:http';
import swagger from '@fastify/swagger';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { VERSION } from '@budgedino/shared';
import { adminGuard, memberGuard } from './auth/guard.js';
import { InMemoryPendingRegistrationStore } from './auth/pending.js';
import { InMemoryRateLimiter } from './auth/rate-limit.js';
import { createChallengeService } from './connectors/challenge-service.js';
import { connectorRoutes } from './connectors/routes.js';
import { createConnectorRegistry } from './connectors/registry.js';
import { createSyncService } from './sync/service.js';
import { syncRoutes } from './sync/routes.js';
import { categorizationRoutes } from './categorization/routes.js';
import { categorizeTransactions } from './categorization/rules.js';
import { detectTransfers } from './categorization/transfers.js';
import { accountRoutes } from './accounts/routes.js';
import { authRoutes } from './auth/routes.js';
import type { AppContext, AppDeps, RouteRegistryEntry } from './deps.js';
import { HttpError } from './http/errors.js';
import { householdRoutes } from './households/routes.js';
import { fastifyLoggerOptions } from './observability/logger.js';
import { safeErrorInfo } from './observability/redact.js';

export const API_PREFIX = '/api/v1';

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_EMAIL_LIMIT = 5;
const LOGIN_IP_LIMIT = 20;
const BODY_LIMIT_BYTES = 64 * 1024;

/**
 * Builds the Fastify app. All routes live under `/api/v1`; each declares `config.access`
 * (`public` | `member` | `admin`) and request/response zod schemas from `@budgedino/shared`.
 */
export function buildApp(deps: AppDeps): FastifyInstance {
  const clock = deps.now ?? (() => new Date());
  const registry = deps.registry ?? createConnectorRegistry([]);
  const sync = createSyncService({
    db: deps.db,
    keyring: deps.keyring,
    registry,
    logger: deps.logger,
    now: clock,
    onIngested:
      deps.onIngested ??
      (async (householdId, txIds) => {
        // Categorize first; transfer detection then claims matched pairs (Transfer beats other non-manual sources).
        await categorizeTransactions(deps.db, deps.keyring, householdId, txIds);
        await detectTransfers(deps.db, deps.keyring, householdId, txIds);
      }),
  });
  const ctx: AppContext = {
    db: deps.db,
    keyring: deps.keyring,
    master: deps.master,
    now: clock,
    pendingRegistrations: deps.pendingRegistrations ?? new InMemoryPendingRegistrationStore(),
    loginEmailLimiter:
      deps.loginEmailLimiter ??
      new InMemoryRateLimiter({
        limit: LOGIN_EMAIL_LIMIT,
        windowMs: LOGIN_WINDOW_MS,
        now: () => clock().getTime(),
      }),
    loginIpLimiter:
      deps.loginIpLimiter ??
      new InMemoryRateLimiter({
        limit: LOGIN_IP_LIMIT,
        windowMs: LOGIN_WINDOW_MS,
        now: () => clock().getTime(),
      }),
    registry,
    sync,
    challenges: createChallengeService({
      db: deps.db,
      keyring: deps.keyring,
      registry,
      logger: deps.logger,
      now: clock,
      sync,
    }),
  };

  // The pino Logger type differs from FastifyBaseLogger only nominally (msgPrefix); widen once here.
  const app = Fastify({
    ...fastifyLoggerOptions(deps.logger),
    trustProxy: deps.trustProxy ?? false,
    bodyLimit: BODY_LIMIT_BYTES,
  }) as unknown as FastifyInstance;

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate('ctx', ctx);
  app.decorateRequest('auth', null);
  app.addHook('onClose', async () => {
    await ctx.sync.idle();
  });

  // Fail closed: a route without `config.access` aborts startup, and the guard for member/admin routes
  // is attached here (never by hand). Guards run in `onRequest`, i.e. before body parsing and
  // validation, so unauthenticated callers get 401 without any request data being processed.
  const routeRegistry: RouteRegistryEntry[] = [];
  app.decorate('routeRegistry', routeRegistry);
  app.addHook('onRoute', (routeOptions) => {
    const methods = [routeOptions.method].flat();
    const access = routeOptions.config?.access;
    if (access !== 'public' && access !== 'member' && access !== 'admin') {
      throw new Error(
        `Route ${methods.join(',')} ${routeOptions.url} must declare config.access ('public' | 'member' | 'admin')`,
      );
    }
    for (const method of methods) {
      routeRegistry.push({ method, url: routeOptions.url, access });
    }
    if (access === 'public') return;
    const guard = access === 'admin' ? adminGuard : memberGuard;
    const existing = routeOptions.onRequest;
    routeOptions.onRequest = [guard, ...(existing ? [existing].flat() : [])];
  });

  // Error bodies are built from fixed strings only: never from request data or parser messages
  // (a JSON parse error message can contain a snippet of the body).
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply
        .code(err.statusCode)
        .headers(err.headers)
        .send({ error: err.code, message: err.message });
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.code(400).send({
        error: 'validation_failed',
        message: 'Request validation failed',
        issues: err.validation.map((issue) => ({
          path: issue.instancePath.replace(/^\//, '').replaceAll('/', '.'),
          message: issue.message ?? 'invalid',
        })),
      });
    }
    const status = (err as { statusCode?: unknown }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return reply.code(status).send({
        error: 'bad_request',
        message: STATUS_CODES[status] ?? 'Bad request',
      });
    }
    req.log.error({ error: safeErrorInfo(err) }, 'unhandled error');
    return reply.code(500).send({ error: 'internal_error', message: 'Internal server error' });
  });
  app.setNotFoundHandler((_req, reply) =>
    reply.code(404).send({ error: 'not_found', message: 'Not found' }),
  );

  void app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'BudgeDino API', version: VERSION },
      components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
    },
    transform: jsonSchemaTransform,
  });

  void app.register(
    async (api) => {
      authRoutes(api);
      accountRoutes(api);
      categorizationRoutes(api);
      householdRoutes(api);
      syncRoutes(api);
      connectorRoutes(api);
    },
    { prefix: API_PREFIX },
  );

  return app;
}

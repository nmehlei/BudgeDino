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
import { InMemoryPendingRegistrationStore } from './auth/pending.js';
import { InMemoryRateLimiter } from './auth/rate-limit.js';
import { authRoutes } from './auth/routes.js';
import type { AppContext, AppDeps } from './deps.js';
import { HttpError } from './http/errors.js';
import { householdRoutes } from './households/routes.js';
import { fastifyLoggerOptions } from './observability/logger.js';

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

  // Error bodies are built from fixed strings only: never from request data or parser messages
  // (a JSON parse error message can contain a snippet of the body).
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: err.code, message: err.message });
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
    req.log.error({ err }, 'unhandled error');
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
    (api, _opts, done) => {
      authRoutes(api);
      householdRoutes(api);
      done();
    },
    { prefix: API_PREFIX },
  );

  return app;
}

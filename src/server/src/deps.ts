import type { MasterKey } from './crypto/index.js';
import type { Db } from './db/client.js';
import type { Keyring } from './households/keyring.js';
import type { PendingRegistrationStore } from './auth/pending.js';
import type { RateLimiter } from './auth/rate-limit.js';
import type { Logger } from './observability/logger.js';

export interface AppDeps {
  db: Db;
  keyring: Keyring;
  master: MasterKey;
  logger: Logger;
  /** Clock; injectable for tests. */
  now?: () => Date;
  /** Fastify `trustProxy`: set when behind a reverse proxy so `req.ip` (rate limits) is the client IP. */
  trustProxy?: boolean | string;
  /** Overrides for the in-memory defaults. */
  pendingRegistrations?: PendingRegistrationStore;
  loginEmailLimiter?: RateLimiter;
  loginIpLimiter?: RateLimiter;
}

/** Resolved dependencies handed to route handlers via `app.ctx`. */
export interface AppContext {
  db: Db;
  keyring: Keyring;
  master: MasterKey;
  now: () => Date;
  pendingRegistrations: PendingRegistrationStore;
  loginEmailLimiter: RateLimiter;
  loginIpLimiter: RateLimiter;
}

export type AccessLevel = 'public' | 'member' | 'admin';

export interface AuthContext {
  memberId: string;
  householdId: string;
  role: 'admin' | 'member';
  sessionId: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
  }
  interface FastifyRequest {
    auth: AuthContext | null;
  }
  interface FastifyContextConfig {
    /** Every route must declare who may call it. */
    access?: AccessLevel;
  }
}

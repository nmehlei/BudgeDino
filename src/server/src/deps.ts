import type { MasterKey } from './crypto/index.js';
import type { Db } from './db/client.js';
import type { ConnectorRegistry } from './connectors/registry.js';
import type { SyncService } from './sync/service.js';
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
  /** Bank connectors available to this server; default none. */
  registry?: ConnectorRegistry;
  /** Categorizer hook, called after each sync with inserted/updated transaction ids; default no-op. */
  onIngested?: (householdId: string, txIds: string[]) => Promise<void>;
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
  registry: ConnectorRegistry;
  sync: SyncService;
}

export type AccessLevel = 'public' | 'member' | 'admin';

export interface AuthContext {
  memberId: string;
  householdId: string;
  role: 'admin' | 'member';
  sessionId: string;
}

export interface RouteRegistryEntry {
  method: string;
  /** Full registered URL including the API prefix, with `:param` placeholders. */
  url: string;
  access: AccessLevel;
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
    /** Every registered route; used by the visibility harness to enumerate GET routes. */
    routeRegistry: RouteRegistryEntry[];
  }
  interface FastifyRequest {
    auth: AuthContext | null;
  }
  interface FastifyContextConfig {
    /** Every route must declare who may call it. */
    access?: AccessLevel;
  }
}

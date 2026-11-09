import type {
  Challenge,
  ChallengeAnswer,
  ChallengeKind,
  CurrencyCode,
  Money,
} from '@budgedino/shared';
import type { Logger } from '../observability/logger.js';

export type { Challenge, ChallengeAnswer, ChallengeKind };

export type Json = string | number | boolean | null | Json[] | { readonly [k: string]: Json };

/** Opaque, JSON-serializable blobs; stored encrypted by the persistence layer. */
export type ConnectorConfig = { readonly [k: string]: Json };
export type ConnectorState = { readonly [k: string]: Json };
/** Server-side only; must never appear in a shared/API type. */
export type DialogState = { readonly [k: string]: Json };

export type AccountKind = 'checking' | 'savings' | 'credit_card' | 'depot' | 'other';

export interface RateLimitPolicy {
  /** null = no per-day cap on unattended fetches. */
  maxUnattendedPerDay: number | null;
  defaultSchedule: { cron: string } | { times: string[] };
}

export interface ConnectorContext {
  now(): Date;
  userPresent: boolean;
  psuIp?: string;
  logger: Logger;
}

export type AuthStep =
  | { done: true; state: ConnectorState; consentExpiresAt?: Date }
  | { done: false; challenge: Challenge; dialog: DialogState };

export interface ProviderAccount {
  ref: string;
  name: string;
  iban?: string;
  kind: AccountKind;
  currency: CurrencyCode;
}

export interface ProviderTransaction {
  providerId: string | null;
  status: 'pending' | 'booked';
  /** ISO date, YYYY-MM-DD. */
  bookingDate: string;
  valueDate?: string;
  amount: Money;
  counterparty?: string;
  counterpartyIban?: string;
  purpose?: string;
  mcc?: string;
}

/**
 * Bank-side problems are results, not exceptions. `state` on failure lets a connector persist
 * progress (e.g. a retry counter) even when the fetch itself failed.
 */
export type FetchResult =
  | { ok: true; transactions: ProviderTransaction[]; balance?: Money; state: ConnectorState }
  | {
      ok: false;
      reason: 'needs_attention' | 'rate_limited' | 'temporary';
      retryAfter?: Date;
      state?: ConnectorState;
    };

/** Terminal, user-visible auth failure (too many wrong answers, wrong answer kind, bad callback). */
export class ConnectorAuthError extends Error {
  constructor(
    readonly reason: 'too_many_attempts' | 'invalid_answer',
    message?: string,
  ) {
    super(message ?? `Connector authentication failed: ${reason}`);
    this.name = 'ConnectorAuthError';
  }
}

export interface Connector {
  type: string;
  experimental: boolean;
  challengeKinds: ChallengeKind[];
  rateLimit: RateLimitPolicy;
  startAuth(config: ConnectorConfig, ctx: ConnectorContext): Promise<AuthStep>;
  continueAuth(
    dialog: DialogState,
    answer: ChallengeAnswer,
    ctx: ConnectorContext,
  ): Promise<AuthStep>;
  listAccounts(state: ConnectorState, ctx: ConnectorContext): Promise<ProviderAccount[]>;
  fetchTransactions(
    state: ConnectorState,
    accountRef: string,
    since: Date | null,
    ctx: ConnectorContext,
  ): Promise<FetchResult>;
}

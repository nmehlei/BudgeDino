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
  | {
      done: false;
      challenge: Challenge;
      dialog: DialogState;
      /** Hint when the bank dialog dies; the server uses min(own TTL, expiresAt). */
      expiresAt?: Date;
    };

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

/**
 * Terminal auth failure: the dialog is over (too many wrong codes, user declined at the bank,
 * bank-side timeout). The server discards the dialog and surfaces the reason.
 */
export class ConnectorAuthError extends Error {
  constructor(
    readonly reason: 'too_many_attempts' | 'declined' | 'timeout',
    message?: string,
  ) {
    super(message ?? `Connector authentication failed: ${reason}`);
    this.name = 'ConnectorAuthError';
  }
}

/** Client mistake (wrong answer kind, malformed callback): the dialog stays valid; map to 4xx. */
export class InvalidAnswerError extends Error {
  constructor(message = 'Invalid answer for the current challenge') {
    super(message);
    this.name = 'InvalidAnswerError';
  }
}

export interface Connector {
  type: string;
  experimental: boolean;
  challengeKinds: ChallengeKind[];
  rateLimit: RateLimitPolicy;
  startAuth(config: ConnectorConfig, ctx: ConnectorContext): Promise<AuthStep>;
  /**
   * Advances the dialog. For a `decoupled` challenge, returning `{done:false}` with the same
   * decoupled challenge means "still pending, poll again after pollAfterMs"; a decline or timeout
   * throws ConnectorAuthError('declined' | 'timeout'). A wrong answer kind throws
   * InvalidAnswerError (dialog stays valid).
   */
  continueAuth(
    dialog: DialogState,
    answer: ChallengeAnswer,
    ctx: ConnectorContext,
  ): Promise<AuthStep>;
  /** Optional: end a dialog early (user cancelled); must not throw. */
  cancelAuth?(dialog: DialogState, ctx: ConnectorContext): Promise<void>;
  listAccounts(state: ConnectorState, ctx: ConnectorContext): Promise<ProviderAccount[]>;
  fetchTransactions(
    state: ConnectorState,
    accountRef: string,
    since: Date | null,
    ctx: ConnectorContext,
  ): Promise<FetchResult>;
}

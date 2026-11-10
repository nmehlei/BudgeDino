import {
  accountInfo,
  accountListResponse,
  ackNotificationsResponse,
  budgetArchivedResponse,
  budgetListResponse,
  budgetResponse,
  challengeAnswerResponse,
  challengeStatusResponse,
  connectStartedResponse,
  connectorListResponse,
  createInviteResponse,
  errorResponse,
  healthResponse,
  homeResponse,
  listTransactionsResponse,
  notificationsResponse,
  patchTransactionResponse,
  reconnectResponse,
  registerResponse,
  sessionListResponse,
  sessionResponse,
  splitsResponse,
  syncStartedResponse,
  type ChallengeAnswer,
  type CreateBudgetRequest,
  type CreateConnectorRequest,
  type CreateInviteRequest,
  type ListTransactionsQuery,
  type LoginRequest,
  type PatchBudgetRequest,
  type PatchTransactionRequest,
  type RegisterConfirmRequest,
  type RegisterRequest,
  type SplitsRequest,
  type UpdateAccountRequest,
} from '@budgedino/shared';
import type { z } from 'zod';

import { ApiClientError, type ValidationIssue } from './errors';

export interface ApiClientOptions {
  baseUrl: string;
  /** Reads the session token (SecureStore). Returning null sends no Authorization header. */
  getToken: () => Promise<string | null> | string | null;
  /** Called on every 401, after which the client throws `{kind:'unauthorized'}`. */
  onUnauthorized: () => Promise<void> | void;
  fetchImpl?: typeof fetch;
  /** Request timeout; a timeout counts as `network`. Default 20 s. */
  timeoutMs?: number;
}

const API_PREFIX = '/api/v1';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RETRY_AFTER_SEC = 60;

type Query = Record<string, string | number | undefined>;

interface RequestSpec<S extends z.ZodType> {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  query?: Query;
  body?: unknown;
  /** Response schema; omit for 204 responses. */
  schema?: S;
}

const idPath = (base: string, id: string, suffix = '') =>
  `${base}/${encodeURIComponent(id)}${suffix}`;

const MAX_RETRY_AFTER_SEC = 3600;

/** Retry-After is delta-seconds or an HTTP date. Anything else falls back to 60 s. */
export function parseRetryAfter(header: string | null, now = Date.now()): number {
  const value = header?.trim() ?? '';
  let seconds = DEFAULT_RETRY_AFTER_SEC;
  if (/^\d+$/.test(value)) {
    seconds = Number.parseInt(value, 10);
  } else {
    const date = Date.parse(value);
    if (value !== '' && !Number.isNaN(date)) seconds = Math.max(0, Math.ceil((date - now) / 1000));
  }
  return Math.min(seconds, MAX_RETRY_AFTER_SEC);
}

async function readIssues(res: Response): Promise<ValidationIssue[]> {
  try {
    const parsed = errorResponse.safeParse(await res.json());
    return parsed.success ? (parsed.data.issues ?? []) : [];
  } catch {
    return [];
  }
}

export function createApiClient(options: ApiClientOptions) {
  const base = options.baseUrl.replace(/\/+$/, '') + API_PREFIX;
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  /** Wipes the session; a failing wipe must not leak a raw error, the caller always sees `unauthorized`. */
  async function failUnauthorized(): Promise<never> {
    try {
      await options.onUnauthorized();
    } catch {
      // The typed error below is what matters to the caller.
    }
    throw new ApiClientError({ kind: 'unauthorized' });
  }

  async function request<S extends z.ZodType>(spec: RequestSpec<S>): Promise<z.output<S>> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(spec.query ?? {})) {
      if (v !== undefined) params.set(k, String(v));
    }
    const qs = params.toString();
    const url = `${base}${spec.path}${qs ? `?${qs}` : ''}`;

    const headers: Record<string, string> = { accept: 'application/json' };
    let token: string | null;
    try {
      token = await options.getToken();
    } catch {
      // SecureStore unreadable (invalidated keystore): the session is unusable, so wipe it.
      return failUnauthorized();
    }
    if (token) headers['authorization'] = `Bearer ${token}`;
    if (spec.body !== undefined) headers['content-type'] = 'application/json';

    // The timeout also covers reading the body; it is cleared only once the body is read.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let res: Response;
      try {
        res = await doFetch(url, {
          method: spec.method,
          headers,
          body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
          signal: controller.signal,
        });
      } catch {
        // Deliberately drops the original error: it can embed the URL. The cache stays untouched.
        throw new ApiClientError({ kind: 'network' });
      }

      if (res.status === 401) return await failUnauthorized();
      if (res.status === 429) {
        throw new ApiClientError({
          kind: 'rate_limited',
          retryAfterSec: parseRetryAfter(res.headers.get('retry-after')),
        });
      }
      if (res.status === 400 || res.status === 422) {
        throw new ApiClientError({ kind: 'validation', issues: await readIssues(res) });
      }
      if (!res.ok) {
        throw new ApiClientError({ kind: 'server', status: res.status });
      }

      if (!spec.schema) return undefined as z.output<S>;
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        throw new ApiClientError({
          kind: controller.signal.aborted ? 'network' : 'schema_mismatch',
        });
      }
      const parsed = spec.schema.safeParse(json);
      if (!parsed.success) throw new ApiClientError({ kind: 'schema_mismatch' });
      return parsed.data;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    // public
    health: () => request({ method: 'GET', path: '/health', schema: healthResponse }),

    // auth
    register: (input: RegisterRequest) =>
      request({ method: 'POST', path: '/auth/register', body: input, schema: registerResponse }),
    registerConfirm: (input: RegisterConfirmRequest) =>
      request({
        method: 'POST',
        path: '/auth/register/confirm',
        body: input,
        schema: sessionResponse,
      }),
    login: (input: LoginRequest) =>
      request({ method: 'POST', path: '/auth/login', body: input, schema: sessionResponse }),
    listSessions: () =>
      request({ method: 'GET', path: '/auth/sessions', schema: sessionListResponse }),
    /** Revokes a session (204). Revoking the current one is the server-side half of sign-out. */
    revokeSession: (id: string) =>
      request({ method: 'DELETE', path: idPath('/auth/sessions', id) }).then(() => undefined),

    // households
    createInvite: (input: CreateInviteRequest = { role: 'member' }) =>
      request({
        method: 'POST',
        path: '/households/invites',
        body: input,
        schema: createInviteResponse,
      }),

    // accounts
    listAccounts: () => request({ method: 'GET', path: '/accounts', schema: accountListResponse }),
    updateAccount: (id: string, input: UpdateAccountRequest) =>
      request({
        method: 'PATCH',
        path: idPath('/accounts', id),
        body: input,
        schema: accountInfo,
      }),

    // connectors
    listConnectors: () =>
      request({ method: 'GET', path: '/connectors', schema: connectorListResponse }),
    createConnector: (input: CreateConnectorRequest) =>
      request({
        method: 'POST',
        path: '/connectors',
        body: input,
        schema: connectStartedResponse,
      }),
    syncConnector: (id: string) =>
      request({
        method: 'POST',
        path: idPath('/connectors', id, '/sync'),
        schema: syncStartedResponse,
      }),
    reconnectConnector: (id: string) =>
      request({
        method: 'POST',
        path: idPath('/connectors', id, '/reconnect'),
        schema: reconnectResponse,
      }),

    // challenges
    getChallenge: (id: string) =>
      request({ method: 'GET', path: idPath('/challenges', id), schema: challengeStatusResponse }),
    answerChallenge: (id: string, answer: ChallengeAnswer) =>
      request({
        method: 'POST',
        path: idPath('/challenges', id, '/answer'),
        body: answer,
        schema: challengeAnswerResponse,
      }),
    cancelChallenge: (id: string) =>
      request({
        method: 'DELETE',
        path: idPath('/challenges', id),
        schema: challengeStatusResponse,
      }),

    // transactions
    listTransactions: (query: Partial<ListTransactionsQuery> = {}) =>
      request({ method: 'GET', path: '/transactions', query, schema: listTransactionsResponse }),
    patchTransaction: (id: string, input: PatchTransactionRequest) =>
      request({
        method: 'PATCH',
        path: idPath('/transactions', id),
        body: input,
        schema: patchTransactionResponse,
      }),
    setTransactionSplits: (id: string, input: SplitsRequest) =>
      request({
        method: 'POST',
        path: idPath('/transactions', id, '/splits'),
        body: input,
        schema: splitsResponse,
      }),

    // budgets
    listBudgets: () => request({ method: 'GET', path: '/budgets', schema: budgetListResponse }),
    createBudget: (input: CreateBudgetRequest) =>
      request({ method: 'POST', path: '/budgets', body: input, schema: budgetResponse }),
    patchBudget: (id: string, input: PatchBudgetRequest) =>
      request({
        method: 'PATCH',
        path: idPath('/budgets', id),
        body: input,
        schema: budgetResponse,
      }),
    archiveBudget: (id: string) =>
      request({ method: 'DELETE', path: idPath('/budgets', id), schema: budgetArchivedResponse }),

    // home
    getHome: (period = 'current') =>
      request({ method: 'GET', path: '/home', query: { period }, schema: homeResponse }),

    // notifications
    listNotifications: (query: { since?: string; limit?: number } = {}) =>
      request({ method: 'GET', path: '/notifications', query, schema: notificationsResponse }),
    ackNotifications: (ids: string[]) =>
      request({
        method: 'POST',
        path: '/notifications/ack',
        body: { ids },
        schema: ackNotificationsResponse,
      }),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

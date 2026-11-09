/**
 * FakeConnector: deterministic, scripted connector used by all sync/challenge/e2e tests.
 * No randomness, no wall clock (only `ctx.now()`); all progress lives in the JSON state/dialog.
 *
 * Config: `{ scenario, transactions?: FakeTx[], accountRef?: string }`. One account (`fake-1`
 * unless overridden). Scenarios:
 * - happy:           startAuth is done immediately.
 * - decoupled:       one `decoupled` challenge; continueAuth({kind:'decoupled'}) is done.
 * - code:            `code` challenge (length 6); correct code is "123456". A wrong code returns the
 *                    same challenge again (not done) with the attempt counted; the 3rd wrong code
 *                    throws ConnectorAuthError('too_many_attempts') (terminal).
 * - redirect:        `redirect` challenge, url https://fake-bank.invalid/auth?state=<nonce>,
 *                    returnUrlScheme 'budgedino'. The callback must contain `code=ok` and the same
 *                    state, otherwise ConnectorAuthError('invalid_answer'). Nonce = `n<ctx.now() ms>`.
 * - expired-consent: auth works; fetchTransactions returns {ok:false, reason:'needs_attention'}.
 * - flaky:           the first fetchTransactions per state returns {ok:false, reason:'temporary'}
 *                    (carrying a state with fetchCount 1); later calls succeed.
 * An answer of the wrong kind throws ConnectorAuthError('invalid_answer').
 * fetchTransactions filters by bookingDate >= since (UTC date compare) and is idempotent.
 */
import { money } from '@budgedino/shared';
import {
  ConnectorAuthError,
  type AuthStep,
  type Challenge,
  type ChallengeAnswer,
  type Connector,
  type ConnectorConfig,
  type ConnectorState,
  type DialogState,
  type FetchResult,
  type Json,
  type ProviderAccount,
  type ProviderTransaction,
} from '../types.js';

export type FakeScenario =
  'happy' | 'decoupled' | 'code' | 'redirect' | 'expired-consent' | 'flaky';

/** JSON-friendly scripted transaction (amount minor units as decimal string). */
export interface FakeTx {
  providerId: string | null;
  status: 'pending' | 'booked';
  bookingDate: string;
  valueDate?: string;
  amountMinor: string;
  currency: string;
  counterparty?: string;
  counterpartyIban?: string;
  purpose?: string;
  mcc?: string;
}

export const FAKE_CORRECT_CODE = '123456';
export const FAKE_MAX_CODE_ATTEMPTS = 3;
const DEFAULT_ACCOUNT_REF = 'fake-1';

const SCENARIOS: readonly string[] = [
  'happy',
  'decoupled',
  'code',
  'redirect',
  'expired-consent',
  'flaky',
];

function readScenario(obj: { readonly [k: string]: Json }): FakeScenario {
  const s = obj['scenario'];
  if (typeof s !== 'string' || !SCENARIOS.includes(s))
    throw new Error(`Invalid fake scenario: ${String(s)}`);
  return s as FakeScenario;
}

function done(config: ConnectorConfig, scenario: FakeScenario): AuthStep {
  return {
    done: true,
    state: {
      scenario,
      accountRef: (config['accountRef'] as string | undefined) ?? DEFAULT_ACCOUNT_REF,
      transactions: config['transactions'] ?? [],
      fetchCount: 0,
    },
  };
}

function fail(reason: 'too_many_attempts' | 'invalid_answer'): never {
  throw new ConnectorAuthError(reason);
}

const CODE_CHALLENGE: Challenge = { kind: 'code', message: 'Enter the fake TAN', length: 6 };

const dateOnly = (d: Date): string => d.toISOString().slice(0, 10);

export function createFakeConnector(): Connector {
  return {
    type: 'fake',
    experimental: false,
    challengeKinds: ['redirect', 'decoupled', 'code', 'image'],
    rateLimit: { maxUnattendedPerDay: null, defaultSchedule: { cron: '0 */4 * * *' } },

    async startAuth(config, ctx) {
      const scenario = readScenario(config);
      switch (scenario) {
        case 'decoupled':
          return {
            done: false,
            challenge: {
              kind: 'decoupled',
              message: 'Confirm in your fake bank app',
              pollAfterMs: 1000,
            },
            dialog: { config, scenario, attempts: 0 },
          };
        case 'code':
          return {
            done: false,
            challenge: CODE_CHALLENGE,
            dialog: { config, scenario, attempts: 0 },
          };
        case 'redirect': {
          const nonce = `n${ctx.now().getTime()}`;
          return {
            done: false,
            challenge: {
              kind: 'redirect',
              url: `https://fake-bank.invalid/auth?state=${nonce}`,
              returnUrlScheme: 'budgedino',
            },
            dialog: { config, scenario, nonce, attempts: 0 },
          };
        }
        default:
          return done(config, scenario);
      }
    },

    async continueAuth(dialog: DialogState, answer: ChallengeAnswer) {
      const config = dialog['config'] as ConnectorConfig;
      const scenario = readScenario(dialog);
      const attempts = (dialog['attempts'] as number | undefined) ?? 0;
      switch (scenario) {
        case 'decoupled':
          if (answer.kind !== 'decoupled') return fail('invalid_answer');
          return done(config, scenario);
        case 'code': {
          if (answer.kind !== 'code' && answer.kind !== 'image') return fail('invalid_answer');
          if (answer.code === FAKE_CORRECT_CODE) return done(config, scenario);
          if (attempts + 1 >= FAKE_MAX_CODE_ATTEMPTS) return fail('too_many_attempts');
          return {
            done: false,
            challenge: CODE_CHALLENGE,
            dialog: { ...dialog, attempts: attempts + 1 },
          };
        }
        case 'redirect': {
          if (answer.kind !== 'redirect') return fail('invalid_answer');
          let params: URLSearchParams;
          try {
            params = new URL(answer.callbackUrl).searchParams;
          } catch {
            return fail('invalid_answer');
          }
          if (params.get('code') !== 'ok' || params.get('state') !== dialog['nonce'])
            return fail('invalid_answer');
          return done(config, scenario);
        }
        default:
          return fail('invalid_answer');
      }
    },

    async listAccounts(state): Promise<ProviderAccount[]> {
      return [
        {
          ref: state['accountRef'] as string,
          name: 'Fake Checking',
          iban: 'DE02120300000000202051',
          kind: 'checking',
          currency: 'EUR',
        },
      ];
    },

    async fetchTransactions(state, accountRef, since): Promise<FetchResult> {
      const scenario = readScenario(state);
      const fetchCount = (state['fetchCount'] as number | undefined) ?? 0;
      if (scenario === 'expired-consent') return { ok: false, reason: 'needs_attention' };
      const next: ConnectorState = { ...state, fetchCount: fetchCount + 1 };
      if (scenario === 'flaky' && fetchCount === 0)
        return { ok: false, reason: 'temporary', state: next };
      if (accountRef !== state['accountRef']) return { ok: true, transactions: [], state: next };
      const from = since ? dateOnly(since) : null;
      const scripted = state['transactions'] as unknown as FakeTx[];
      const transactions: ProviderTransaction[] = scripted
        .filter((t) => from === null || t.bookingDate >= from)
        .map(({ amountMinor, currency, ...rest }) => ({
          ...rest,
          amount: money(BigInt(amountMinor), currency),
        }));
      return { ok: true, transactions, state: next };
    },
  };
}

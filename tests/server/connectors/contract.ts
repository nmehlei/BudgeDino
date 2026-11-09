import { describe, expect, it } from 'vitest';
import { challenge as challengeSchema, type ChallengeAnswer } from '@budgedino/shared';
import { createLogger } from '@budgedino/server/observability/logger';
import type {
  AuthStep,
  Connector,
  ConnectorConfig,
  ConnectorContext,
  ConnectorState,
  ProviderTransaction,
} from '@budgedino/server/connectors/types';

export interface ConnectorContractScript {
  config: ConnectorConfig;
  /** Produces the answer a user would give for each challenge the connector raises. */
  answer(challenge: Extract<AuthStep, { done: false }>['challenge']): ChallengeAnswer;
  accountRef: string;
  /** Filter used for the since checks; null checks the unfiltered path. */
  since: Date | null;
  /**
   * Produces a state for which the (fake) bank fails on fetch. The contract asserts the connector
   * then returns `ok:false` instead of throwing.
   */
  failingState: () => Promise<ConnectorState>;
}

const KNOWN_STATUSES = ['pending', 'booked'];
const KNOWN_REASONS = ['needs_attention', 'rate_limited', 'temporary'];

export function makeCtx(
  now = new Date('2026-01-15T12:00:00Z'),
  userPresent = true,
): ConnectorContext {
  return { now: () => now, userPresent, logger: createLogger({ level: 'silent' }) };
}

/** Everything persisted between steps must survive JSON. */
const rt = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Drives the dialog until done, round-tripping config/dialog/state through JSON between steps. */
export async function authenticate(
  c: Connector,
  config: ConnectorConfig,
  answer: ConnectorContractScript['answer'],
  ctx = makeCtx(),
): Promise<ConnectorState> {
  let step = await c.startAuth(rt(config), ctx);
  for (let i = 0; i < 10 && !step.done; i++) {
    const ch = rt(step.challenge);
    expect(() => challengeSchema.parse(ch)).not.toThrow();
    expect(c.challengeKinds).toContain(ch.kind);
    step = await c.continueAuth(rt(step.dialog), answer(ch), ctx);
  }
  if (!step.done) throw new Error('auth did not complete');
  return rt(step.state);
}

function assertWellFormed(t: ProviderTransaction): void {
  expect(KNOWN_STATUSES).toContain(t.status);
  expect(typeof t.amount.minor).toBe('bigint');
  expect(t.amount.currency).toMatch(/^[A-Z]{3}$/);
  expect(t.bookingDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
}

/** Reusable by any connector (e.g. FinTS against its own fake server). */
export function runConnectorContract(
  name: string,
  make: () => Connector,
  script: ConnectorContractScript,
): void {
  describe(`connector contract: ${name}`, () => {
    it('declares sane metadata', () => {
      const c = make();
      expect(c.type).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(c.challengeKinds.length).toBeGreaterThan(0);
    });

    it('auth completes with schema-valid challenges and JSON-safe data between steps', async () => {
      const state = await authenticate(make(), script.config, script.answer);
      expect(state).toBeTypeOf('object');
    });

    it('lists accounts including the scripted one', async () => {
      const c = make();
      const state = await authenticate(c, script.config, script.answer);
      const accounts = await c.listAccounts(rt(state), makeCtx(), script.config);
      expect(accounts.map((a) => a.ref)).toContain(script.accountRef);
    });

    it('fetchTransactions is idempotent, well-formed and honours since', async () => {
      const c = make();
      const state = await authenticate(c, script.config, script.answer);
      const ctx = makeCtx();
      let first = await c.fetchTransactions(
        state,
        script.accountRef,
        script.since,
        ctx,
        script.config,
      );
      if (!first.ok) {
        // a transient failure is allowed once; retry with the state the connector handed back
        first = await c.fetchTransactions(
          rt(first.state ?? state),
          script.accountRef,
          script.since,
          ctx,
          script.config,
        );
      }
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const second = await c.fetchTransactions(
        rt(first.state ?? state),
        script.accountRef,
        script.since,
        ctx,
        script.config,
      );
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.transactions).toEqual(first.transactions);
      for (const t of first.transactions) {
        assertWellFormed(t);
        if (script.since) {
          expect(t.bookingDate >= script.since.toISOString().slice(0, 10)).toBe(true);
        }
      }
    });

    it('unattended fetch (userPresent=false) never throws or needs interaction', async () => {
      const c = make();
      const state = await authenticate(c, script.config, script.answer);
      const result = await c.fetchTransactions(
        state,
        script.accountRef,
        script.since,
        makeCtx(undefined, false),
        script.config,
      );
      if (!result.ok) expect(KNOWN_REASONS).toContain(result.reason);
    });

    it('returns ok:false (never throws) when the bank fails', async () => {
      const c = make();
      const state = await script.failingState();
      const result = await c.fetchTransactions(
        rt(state),
        script.accountRef,
        script.since,
        makeCtx(),
        script.config,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(KNOWN_REASONS).toContain(result.reason);
    });
  });
}

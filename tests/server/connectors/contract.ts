import { describe, expect, it } from 'vitest';
import type { ChallengeAnswer } from '@budgedino/shared';
import { createLogger } from '@budgedino/server/observability/logger';
import type {
  AuthStep,
  Connector,
  ConnectorConfig,
  ConnectorContext,
  ConnectorState,
} from '@budgedino/server/connectors/types';

export interface ConnectorContractScript {
  config: ConnectorConfig;
  /** Produces the answer a user would give for each challenge the connector raises. */
  answer(challenge: Extract<AuthStep, { done: false }>['challenge']): ChallengeAnswer;
  accountRef: string;
  since: Date | null;
}

const KNOWN_STATUSES = ['pending', 'booked'];

export function makeCtx(now = new Date('2026-01-15T12:00:00Z')): ConnectorContext {
  return { now: () => now, userPresent: true, logger: createLogger({ level: 'silent' }) };
}

/** Drives the dialog until done; fails if it does not finish within a few steps. */
export async function authenticate(
  c: Connector,
  config: ConnectorConfig,
  answer: ConnectorContractScript['answer'],
  ctx = makeCtx(),
): Promise<ConnectorState> {
  let step = await c.startAuth(config, ctx);
  for (let i = 0; i < 5 && !step.done; i++) {
    expect(c.challengeKinds).toContain(step.challenge.kind);
    step = await c.continueAuth(step.dialog, answer(step.challenge), ctx);
  }
  if (!step.done) throw new Error('auth did not complete');
  return step.state;
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

    it('auth eventually completes', async () => {
      const state = await authenticate(make(), script.config, script.answer);
      expect(state).toBeTypeOf('object');
    });

    it('lists accounts including the scripted one', async () => {
      const c = make();
      const state = await authenticate(c, script.config, script.answer);
      const accounts = await c.listAccounts(state, makeCtx());
      expect(accounts.map((a) => a.ref)).toContain(script.accountRef);
    });

    it('fetchTransactions is idempotent for the same since and uses only known statuses', async () => {
      const c = make();
      const state = await authenticate(c, script.config, script.answer);
      const ctx = makeCtx();
      let first = await c.fetchTransactions(state, script.accountRef, script.since, ctx);
      if (!first.ok) {
        // transient failures are allowed once; retry with the state the connector handed back
        first = await c.fetchTransactions(
          first.state ?? state,
          script.accountRef,
          script.since,
          ctx,
        );
      }
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const second = await c.fetchTransactions(first.state, script.accountRef, script.since, ctx);
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.transactions).toEqual(first.transactions);
      for (const t of first.transactions) expect(KNOWN_STATUSES).toContain(t.status);
    });

    it('never throws for bank-side errors (returns ok:false with a known reason)', async () => {
      const c = make();
      const state = await authenticate(c, script.config, script.answer);
      const result = await c.fetchTransactions(state, script.accountRef, script.since, makeCtx());
      if (!result.ok) {
        expect(['needs_attention', 'rate_limited', 'temporary']).toContain(result.reason);
      }
    });
  });
}

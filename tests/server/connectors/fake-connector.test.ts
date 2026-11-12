import { describe, expect, it } from 'vitest';
import { challenge, challengeAnswer } from '@budgedino/shared';
import {
  createFakeConnector,
  type FakeScenario,
  type FakeTx,
} from '@budgedino/server/connectors/fake/fake-connector';
import {
  createConnectorRegistry,
  UnknownConnectorError,
} from '@budgedino/server/connectors/registry';
import { InvalidAnswerError, type ConnectorConfig } from '@budgedino/server/connectors/types';
import { authenticate, makeCtx, runConnectorContract } from './contract';

const txs: FakeTx[] = [
  {
    providerId: 'a',
    status: 'booked',
    bookingDate: '2026-01-01',
    amountMinor: '-1250',
    currency: 'EUR',
    purpose: 'old',
  },
  {
    providerId: 'b',
    status: 'booked',
    bookingDate: '2026-01-10',
    amountMinor: '-999',
    currency: 'EUR',
    counterparty: 'Shop',
  },
  {
    providerId: null,
    status: 'pending',
    bookingDate: '2026-01-12',
    amountMinor: '5000',
    currency: 'EUR',
  },
];
const cfg = (scenario: FakeScenario): ConnectorConfig => ({
  scenario,
  transactions: txs as unknown as ConnectorConfig['transactions'],
});
const ctx = makeCtx();
const fake = createFakeConnector();

const answerFor = (c: ReturnType<typeof challenge.parse>) => {
  switch (c.kind) {
    case 'redirect': {
      const state = new URL(c.url).searchParams.get('state');
      return { kind: 'redirect' as const, callbackUrl: `budgedino://cb?code=ok&state=${state}` };
    }
    case 'decoupled':
      return { kind: 'decoupled' as const };
    default:
      return { kind: c.kind, code: '123456' };
  }
};

for (const scenario of ['happy', 'decoupled', 'code', 'redirect', 'flaky'] as const) {
  runConnectorContract(`fake/${scenario}`, createFakeConnector, {
    config: cfg(scenario),
    answer: answerFor,
    accountRef: 'fake-1',
    since: scenario === 'happy' ? new Date('2026-01-10T00:00:00Z') : null,
    failingState: () => authenticate(createFakeConnector(), cfg('expired-consent'), answerFor),
  });
}

describe('FakeConnector', () => {
  it('has the declared metadata', () => {
    expect(fake.type).toBe('fake');
    expect(fake.experimental).toBe(false);
    expect(fake.challengeKinds).toEqual(['redirect', 'decoupled', 'code', 'image']);
    expect(fake.rateLimit).toEqual({
      maxUnattendedPerDay: null,
      defaultSchedule: { cron: '0 */4 * * *' },
    });
  });

  it('happy: done immediately', async () => {
    expect((await fake.startAuth(cfg('happy'), ctx)).done).toBe(true);
  });

  it('decoupled: one decoupled challenge, then done', async () => {
    const step = await fake.startAuth(cfg('decoupled'), ctx);
    if (step.done) throw new Error('expected challenge');
    expect(challenge.parse(step.challenge).kind).toBe('decoupled');
    const next = await fake.continueAuth(
      step.dialog,
      challengeAnswer.parse({ kind: 'decoupled' }),
      ctx,
    );
    expect(next.done).toBe(true);
  });

  it('code: wrong code repeats the challenge, third wrong code is terminal', async () => {
    let step = await fake.startAuth(cfg('code'), ctx);
    if (step.done) throw new Error('expected challenge');
    for (let i = 0; i < 2; i++) {
      step = await fake.continueAuth(step.dialog, { kind: 'code', code: '000000' }, ctx);
      if (step.done) throw new Error('should not be done');
      expect(step.challenge.kind).toBe('code');
    }
    await expect(
      fake.continueAuth(step.dialog, { kind: 'code', code: '000000' }, ctx),
    ).rejects.toMatchObject({
      name: 'ConnectorAuthError',
      reason: 'too_many_attempts',
    });
  });

  it('code: correct code after a wrong one succeeds', async () => {
    let step = await fake.startAuth(cfg('code'), ctx);
    if (step.done) throw new Error('expected challenge');
    step = await fake.continueAuth(step.dialog, { kind: 'code', code: '1' }, ctx);
    if (step.done) throw new Error('should not be done');
    expect((await fake.continueAuth(step.dialog, { kind: 'code', code: '123456' }, ctx)).done).toBe(
      true,
    );
  });

  it('redirect: url carries the dialog nonce; callback needs code=ok and same state', async () => {
    const step = await fake.startAuth(cfg('redirect'), ctx);
    if (step.done) throw new Error('expected challenge');
    expect(step.challenge).toMatchObject({ kind: 'redirect', returnUrlScheme: 'budgedino' });
    const url = (step.challenge as { url: string }).url;
    expect(url).toMatch(/^https:\/\/fake-bank\.invalid\/auth\?state=.+/);
    const state = new URL(url).searchParams.get('state');
    const bad1 = fake.continueAuth(
      step.dialog,
      { kind: 'redirect', callbackUrl: `budgedino://cb?code=ok&state=other` },
      ctx,
    );
    await expect(bad1).rejects.toBeInstanceOf(InvalidAnswerError);
    const bad2 = fake.continueAuth(
      step.dialog,
      { kind: 'redirect', callbackUrl: `budgedino://cb?code=no&state=${state}` },
      ctx,
    );
    await expect(bad2).rejects.toBeInstanceOf(InvalidAnswerError);
    const ok = await fake.continueAuth(
      step.dialog,
      { kind: 'redirect', callbackUrl: `budgedino://cb?code=ok&state=${state}` },
      ctx,
    );
    expect(ok.done).toBe(true);
  });

  it('wrong answer kind is rejected', async () => {
    const step = await fake.startAuth(cfg('decoupled'), ctx);
    if (step.done) throw new Error('expected challenge');
    await expect(
      fake.continueAuth(step.dialog, { kind: 'code', code: 'x' }, ctx),
    ).rejects.toBeInstanceOf(InvalidAnswerError);
    // dialog stays valid after a client mistake
    expect((await fake.continueAuth(step.dialog, { kind: 'decoupled' }, ctx)).done).toBe(true);
  });

  it('decoupled with pendingPolls: same challenge N times, then done; cancelAuth is safe', async () => {
    let step = await fake.startAuth({ ...cfg('decoupled'), pendingPolls: 2 }, ctx);
    for (let i = 0; i < 2; i++) {
      if (step.done) throw new Error('expected pending');
      expect(step.challenge.kind).toBe('decoupled');
      step = await fake.continueAuth(
        JSON.parse(JSON.stringify(step.dialog)),
        { kind: 'decoupled' },
        ctx,
      );
    }
    if (step.done) throw new Error('expected still pending after 2 polls');
    expect(step.challenge.kind).toBe('decoupled');
    await expect(fake.cancelAuth?.(step.dialog, ctx)).resolves.toBeUndefined();
    expect((await fake.continueAuth(step.dialog, { kind: 'decoupled' }, ctx)).done).toBe(true);
  });

  it('not-done steps carry expiresAt = now + 10 min', async () => {
    const step = await fake.startAuth(cfg('code'), ctx);
    if (step.done) throw new Error('expected challenge');
    expect(step.expiresAt).toEqual(new Date(ctx.now().getTime() + 10 * 60 * 1000));
  });

  it('expired-consent: auth works, fetch needs attention', async () => {
    const state = await authenticate(fake, cfg('expired-consent'), answerFor);
    expect(await fake.fetchTransactions(state, 'fake-1', null, ctx)).toMatchObject({
      ok: false,
      reason: 'needs_attention',
    });
  });

  it('flaky: first fetch per state is temporary, then succeeds; tracked via state', async () => {
    const state = await authenticate(fake, cfg('flaky'), answerFor);
    const first = await fake.fetchTransactions(state, 'fake-1', null, ctx);
    expect(first).toMatchObject({ ok: false, reason: 'temporary' });
    // same original state fails again (no hidden global counter)
    expect(await fake.fetchTransactions(state, 'fake-1', null, ctx)).toMatchObject({ ok: false });
    if (first.ok || !first.state) throw new Error('expected failure with state');
    const next = first.state;
    expect((await fake.fetchTransactions(next, 'fake-1', null, ctx)).ok).toBe(true);
  });

  it('filters by bookingDate >= since (UTC date compare) and converts amounts to Money', async () => {
    const state = await authenticate(fake, cfg('happy'), answerFor);
    const r = await fake.fetchTransactions(state, 'fake-1', new Date('2026-01-10T23:59:59Z'), ctx);
    if (!r.ok) throw new Error('expected ok');
    expect(r.transactions.map((t) => t.providerId)).toEqual(['b', null]);
    expect(r.transactions[0]?.amount).toEqual({ minor: -999n, currency: 'EUR' });
    const all = await fake.fetchTransactions(state, 'fake-1', null, ctx);
    expect(all.ok && all.transactions).toHaveLength(3);
  });

  it('states and dialogs survive a JSON round-trip and keep working', async () => {
    const rt = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
    for (const scenario of [
      'happy',
      'decoupled',
      'code',
      'redirect',
      'expired-consent',
      'flaky',
    ] as const) {
      let step = await fake.startAuth(rt(cfg(scenario)), ctx);
      for (let i = 0; i < 3 && !step.done; i++) {
        step = await fake.continueAuth(rt(step.dialog), answerFor(rt(step.challenge)), ctx);
      }
      if (!step.done) throw new Error('not done');
      const state = rt(step.state);
      expect((await fake.listAccounts(state, ctx)).length).toBe(1);
      const r = await fake.fetchTransactions(state, 'fake-1', null, ctx);
      if (scenario === 'expired-consent') expect(r.ok).toBe(false);
      else if (scenario === 'flaky') {
        expect(r.ok).toBe(false);
        const again = await fake.fetchTransactions(
          rt(r.ok ? {} : (r.state ?? {})),
          'fake-1',
          null,
          ctx,
        );
        expect(again.ok).toBe(true);
      } else expect(r.ok).toBe(true);
    }
  });
});

describe('connector registry', () => {
  it('returns registered connectors and throws a typed error for unknown ones', () => {
    const reg = createConnectorRegistry([fake]);
    expect(reg.get('fake')).toBe(fake);
    expect(() => reg.get('nope')).toThrow(UnknownConnectorError);
  });

  it('rejects duplicate types', () => {
    expect(() => createConnectorRegistry([fake, fake])).toThrow(/Duplicate/);
  });
});

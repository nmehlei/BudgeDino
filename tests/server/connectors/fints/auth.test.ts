import { describe, expect, it } from 'vitest';
import type { ChallengeAnswer } from '@budgedino/shared';
import { createLogger } from '@budgedino/server/observability/logger';
import { createFinTSConnector } from '@budgedino/server/connectors/fints/connector';
import { FinTSDialogRegistry } from '@budgedino/server/connectors/fints/dialogs';
import type { FinTSAccount, FinTSTanMethod } from '@budgedino/server/connectors/fints/port';
import {
  ConnectorAuthError,
  InvalidAnswerError,
  type AuthStep,
  type Connector,
  type ConnectorContext,
} from '@budgedino/server/connectors/types';
import {
  DEFAULT_BANKING_INFORMATION,
  SCRIPTED_CORRECT_CODE,
  ScriptedFinTSPort,
  type ScriptedScenario,
} from '../../../support/fints/scripted-port';

const PIN = 'PIN-CANARY-7731';
const USER = 'USER-CANARY-4412';
const NOW = new Date('2026-11-09T10:00:00.000Z');

const ctx: ConnectorContext = {
  now: () => NOW,
  userPresent: true,
  logger: createLogger({ level: 'silent' }),
};

const config = { bank: 'dkb', userId: USER, pin: PIN } as const;

const CHECKING: FinTSAccount = {
  iban: 'DE89370400440532013000',
  accountNumber: '532013000',
  blz: '12030000',
  accountType: 'CheckingAccount',
};
const CARD: FinTSAccount = {
  accountNumber: '4111',
  blz: '12030000',
  accountType: 'CreditCardAccount',
};

const decoupled: FinTSTanMethod = { id: 920, name: 'DKB App', decoupled: true, kind: 'decoupled' };
const pushTan: FinTSTanMethod = { id: 940, name: 'SMS', decoupled: false, kind: 'code' };
const photoTan: FinTSTanMethod = { id: 950, name: 'photoTAN', decoupled: false, kind: 'photo' };
const chip: FinTSTanMethod = {
  id: 960,
  name: 'chipTAN optisch',
  decoupled: false,
  kind: 'chiptan-optical',
};

function setup(scenario: ScriptedScenario) {
  const port = new ScriptedFinTSPort(scenario);
  const dialogs = new FinTSDialogRegistry({ now: ctx.now });
  const connector = createFinTSConnector({
    port,
    dialogs,
    product: { id: 'PID', version: '1.0' },
  });
  return { port, dialogs, connector };
}

const rt = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const pending = (s: AuthStep) => {
  if (s.done) throw new Error('expected a challenge');
  return s;
};
const finished = (s: AuthStep) => {
  if (!s.done) throw new Error('expected done');
  return s;
};
const methodId = (s: AuthStep) => (finished(s).state as { tanMethodId: number }).tanMethodId;

/** Every step's JSON, minus the (intentionally secret-bearing) state.bankingInformation. */
function scrubbed(step: AuthStep): string {
  if (step.done) {
    const rest: Record<string, unknown> = { ...step.state };
    delete rest['bankingInformation'];
    return JSON.stringify({ ...step, state: rest });
  }
  return JSON.stringify(step);
}

const rightAnswers = (ch: { kind: string }): ChallengeAnswer =>
  ch.kind === 'decoupled'
    ? { kind: 'decoupled' }
    : ch.kind === 'image'
      ? { kind: 'image', code: SCRIPTED_CORRECT_CODE }
      : { kind: 'code', code: SCRIPTED_CORRECT_CODE };

async function drive(connector: Connector, steps: AuthStep[] = []): Promise<AuthStep> {
  let step = await connector.startAuth(rt(config), ctx);
  steps.push(step);
  for (let i = 0; i < 20 && !step.done; i++) {
    step = await connector.continueAuth(rt(step.dialog), rightAnswers(step.challenge), ctx);
    steps.push(step);
  }
  return step;
}

describe('FinTS connector metadata', () => {
  it('declares type, kinds, schema and schedule', () => {
    const { connector } = setup({});
    expect(connector.type).toBe('fints');
    expect(connector.experimental).toBe(false);
    expect(connector.challengeKinds).toEqual(['decoupled', 'code', 'image']);
    expect(connector.configSchema).toBeDefined();
    expect(connector.rateLimit).toEqual({
      maxUnattendedPerDay: null,
      defaultSchedule: { cron: '0 */4 * * *' },
    });
  });
});

describe('FinTS authentication', () => {
  it('finishes immediately when the bank demands no TAN', async () => {
    const { connector, port } = setup({});
    const step = finished(await connector.startAuth(rt(config), ctx));
    expect(step.state).toEqual({
      bankingInformation: DEFAULT_BANKING_INFORMATION,
      tanMethodId: 920,
      systemId: 'SYS-SCRIPTED',
    });
    expect(step.consentExpiresAt).toEqual(new Date(NOW.getTime() + 90 * 86_400_000));
    expect(port.callsOf('openFirstTime')[0]?.args[0]).toMatchObject({
      productId: 'PID',
      productVersion: '1.0',
      url: 'https://fints.dkb.de/fints',
      blz: '12030000',
      userId: USER,
      pin: PIN,
    });
  });

  it('DKB-like decoupled: keeps polling with the same challenge, then done', async () => {
    const { connector, port } = setup({
      syncRequiresTan: 'decoupled',
      decoupledPendingPolls: 2,
      tanChallenge: '  Bitte  bestaetigen\u0000 Sie\n in der App ',
    });
    const first = pending(await connector.startAuth(rt(config), ctx));
    expect(first.challenge).toEqual({
      kind: 'decoupled',
      message: 'Bitte bestaetigen Sie in der App',
      pollAfterMs: 3000,
    });
    expect(first.expiresAt).toEqual(new Date(NOW.getTime() + 10 * 60_000));

    const poll1 = pending(
      await connector.continueAuth(rt(first.dialog), { kind: 'decoupled' }, ctx),
    );
    expect(poll1.challenge).toEqual(first.challenge);
    const poll2 = pending(
      await connector.continueAuth(rt(poll1.dialog), { kind: 'decoupled' }, ctx),
    );
    expect(poll2.challenge).toEqual(first.challenge);
    const done = await connector.continueAuth(rt(poll2.dialog), { kind: 'decoupled' }, ctx);
    expect(methodId(done)).toBe(920);

    expect(port.callsOf('synchronizeWithTan').map((c) => c.args)).toEqual([
      ['REF-SYNC', undefined],
      ['REF-SYNC', undefined],
      ['REF-SYNC', undefined],
    ]);
  });

  it('truncates the bank text to 200 chars', async () => {
    const { connector } = setup({ syncRequiresTan: 'decoupled', tanChallenge: 'x'.repeat(300) });
    const s = pending(await connector.startAuth(rt(config), ctx));
    expect(s.challenge.kind === 'decoupled' && s.challenge.message).toHaveLength(200);
  });

  it('code TAN: wrong then right', async () => {
    const { connector } = setup({ tanMethods: [pushTan], syncRequiresTan: 'code' });
    const first = pending(await connector.startAuth(rt(config), ctx));
    expect(first.challenge.kind).toBe('code');
    const retry = pending(
      await connector.continueAuth(rt(first.dialog), { kind: 'code', code: '000000' }, ctx),
    );
    expect(retry.challenge.kind).toBe('code');
    const done = await connector.continueAuth(
      rt(retry.dialog),
      { kind: 'code', code: SCRIPTED_CORRECT_CODE },
      ctx,
    );
    expect(methodId(done)).toBe(940);
  });

  it('declines with too_many_attempts after 3 wrong codes', async () => {
    const { connector } = setup({ tanMethods: [pushTan], syncRequiresTan: 'code' });
    let step = pending(await connector.startAuth(rt(config), ctx));
    for (let i = 0; i < 2; i++)
      step = pending(
        await connector.continueAuth(rt(step.dialog), { kind: 'code', code: '1' }, ctx),
      );
    await expect(
      connector.continueAuth(rt(step.dialog), { kind: 'code', code: '1' }, ctx),
    ).rejects.toMatchObject({ name: 'ConnectorAuthError', reason: 'too_many_attempts' });
  });

  it('photoTAN: image challenge with base64 PNG', async () => {
    const { connector } = setup({ tanMethods: [photoTan], syncRequiresTan: 'photo' });
    const s = pending(await connector.startAuth(rt(config), ctx));
    expect(s.challenge.kind).toBe('image');
    if (s.challenge.kind !== 'image') throw new Error('unreachable');
    expect(s.challenge.mimeType).toBe('image/png');
    expect(Buffer.from(s.challenge.imageBase64, 'base64').subarray(1, 4).toString()).toBe('PNG');
    const done = await connector.continueAuth(
      rt(s.dialog),
      { kind: 'image', code: SCRIPTED_CORRECT_CODE },
      ctx,
    );
    expect(methodId(done)).toBe(950);
  });

  it('photoTAN: JPEG is passed through with its mime type; other formats are declined', async () => {
    const jpeg = Uint8Array.of(0xff, 0xd8, 0xff);
    const a = setup({
      tanMethods: [photoTan],
      syncRequiresTan: 'photo',
      photo: { mimeType: 'image/jpeg', data: jpeg },
    });
    const s = pending(await a.connector.startAuth(rt(config), ctx));
    expect(s.challenge).toMatchObject({
      kind: 'image',
      mimeType: 'image/jpeg',
      imageBase64: Buffer.from(jpeg).toString('base64'),
    });
    const b = setup({
      tanMethods: [photoTan],
      syncRequiresTan: 'photo',
      photo: { mimeType: 'image/gif', data: jpeg },
    });
    await expect(b.connector.startAuth(rt(config), ctx)).rejects.toMatchObject({
      reason: 'declined',
      message: 'unsupported photoTAN format',
    });
  });

  it('a rejected TAN restarts the order for a fresh reference (sync)', async () => {
    const { connector, port } = setup({
      tanMethods: [photoTan],
      syncRequiresTan: 'photo',
      refuseReusedTanReference: true,
    });
    const first = pending(await connector.startAuth(rt(config), ctx));
    const retry = pending(
      await connector.continueAuth(rt(first.dialog), { kind: 'image', code: '000000' }, ctx),
    );
    expect(retry.challenge.kind).toBe('image');
    expect(port.callsOf('synchronize')).toHaveLength(3);
    const done = await connector.continueAuth(
      rt(retry.dialog),
      { kind: 'image', code: SCRIPTED_CORRECT_CODE },
      ctx,
    );
    finished(done);
    expect(port.callsOf('synchronizeWithTan').map((c) => c.args[0])).toEqual([
      'REF-SYNC',
      'REF-SYNC-1',
    ]);
  });

  it('too_many_attempts still applies across restarts', async () => {
    const { connector } = setup({
      tanMethods: [pushTan],
      syncRequiresTan: 'code',
      refuseReusedTanReference: true,
    });
    let step = pending(await connector.startAuth(rt(config), ctx));
    for (let i = 0; i < 2; i++)
      step = pending(
        await connector.continueAuth(rt(step.dialog), { kind: 'code', code: '1' }, ctx),
      );
    await expect(
      connector.continueAuth(rt(step.dialog), { kind: 'code', code: '1' }, ctx),
    ).rejects.toMatchObject({ reason: 'too_many_attempts' });
  });

  it.each([
    ['checking', CHECKING, 'getStatements', 'getStatementsWithTan'],
    ['credit-card', CARD, 'getCreditCardStatements', 'getCreditCardStatementsWithTan'],
  ] as const)(
    'probe TAN (%s): continued with the matching call, restart on rejection',
    async (_n, acc, probe, withTan) => {
      const { connector, port } = setup({
        tanMethods: [pushTan],
        syncRequiresTan: 'code',
        statementsRequireTan: true,
        accounts: [acc],
        refuseReusedTanReference: true,
      });
      let step = pending(await connector.startAuth(rt(config), ctx));
      step = pending(
        await connector.continueAuth(
          rt(step.dialog),
          { kind: 'code', code: SCRIPTED_CORRECT_CODE },
          ctx,
        ),
      );
      expect(port.callsOf(probe)).toHaveLength(1);
      // wrong code: the order is restarted (probe re-run), then the right code finishes
      step = pending(
        await connector.continueAuth(rt(step.dialog), { kind: 'code', code: '9' }, ctx),
      );
      expect(port.callsOf(probe)).toHaveLength(2);
      finished(
        await connector.continueAuth(
          rt(step.dialog),
          { kind: 'code', code: SCRIPTED_CORRECT_CODE },
          ctx,
        ),
      );
      expect(port.callsOf(withTan).map((c) => c.args[0])).toEqual(['REF-STMT', 'REF-STMT-1']);
      const other =
        withTan === 'getStatementsWithTan'
          ? 'getCreditCardStatementsWithTan'
          : 'getStatementsWithTan';
      expect(port.callsOf(other)).toHaveLength(0);
    },
  );

  it('chipTAN-optical only is declined', async () => {
    const { connector } = setup({ tanMethods: [chip] });
    await expect(connector.startAuth(rt(config), ctx)).rejects.toMatchObject({
      reason: 'declined',
      message: 'no supported TAN method',
    });
  });

  it('prefers decoupled, then code, then photo; never chipTAN', async () => {
    const a = setup({ tanMethods: [chip, photoTan, pushTan, decoupled] });
    finished(await a.connector.startAuth(rt(config), ctx));
    expect(a.port.callsOf('selectTanMethod')[0]?.args).toEqual([920]);
    const b = setup({ tanMethods: [chip, photoTan, pushTan] });
    finished(await b.connector.startAuth(rt(config), ctx));
    expect(b.port.callsOf('selectTanMethod')[0]?.args).toEqual([940]);
    const c = setup({ tanMethods: [chip, photoTan] });
    finished(await c.connector.startAuth(rt(config), ctx));
    expect(c.port.callsOf('selectTanMethod')[0]?.args).toEqual([950]);
  });

  it('honours config.tanMethodId when available, falls back when not, declines chipTAN', async () => {
    const methods = [decoupled, pushTan, chip];
    const a = setup({ tanMethods: methods });
    finished(await a.connector.startAuth({ ...config, tanMethodId: 940 }, ctx));
    expect(a.port.callsOf('selectTanMethod')[0]?.args).toEqual([940]);
    const b = setup({ tanMethods: methods });
    finished(await b.connector.startAuth({ ...config, tanMethodId: 111 }, ctx));
    expect(b.port.callsOf('selectTanMethod')[0]?.args).toEqual([920]);
    const c = setup({ tanMethods: methods });
    await expect(c.connector.startAuth({ ...config, tanMethodId: 960 }, ctx)).rejects.toMatchObject(
      { reason: 'declined' },
    );
  });

  it.each(['wrong-pin', 'locked'] as const)(
    '%s is declined without leaking bank text',
    async (failWith) => {
      const { connector } = setup({ failWith });
      const err = await connector.startAuth(rt(config), ctx).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConnectorAuthError);
      expect((err as ConnectorAuthError).reason).toBe('declined');
      expect((err as Error).message).not.toContain('USER-TEXT-LEAK');
    },
  );

  it('a port failure becomes a plain fints_failed error', async () => {
    const { connector } = setup({ failWith: 'server-error' });
    const err = await connector.startAuth(rt(config), ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ConnectorAuthError);
    expect((err as Error).message).toBe('fints_failed');
  });

  it('statements probe: a second challenge covers account access, then done', async () => {
    const { connector, port } = setup({
      syncRequiresTan: 'decoupled',
      statementsRequireTan: true,
      accounts: [CHECKING],
    });
    const steps: AuthStep[] = [];
    const end = await drive(connector, steps);
    expect(end.done).toBe(true);
    expect(steps.filter((s) => !s.done)).toHaveLength(2);
    const [acc, from, to] = port.callsOf('getStatements')[0]?.args as [FinTSAccount, Date, Date];
    expect(acc).toEqual(CHECKING);
    expect(to.getTime() - from.getTime()).toBe(3 * 86_400_000);
    expect(port.callsOf('getStatementsWithTan')).toHaveLength(1);
  });

  it('probe without TAN need finishes directly; credit card uses card statements', async () => {
    const a = setup({ accounts: [CARD] });
    finished(await a.connector.startAuth(rt(config), ctx));
    expect(a.port.callsOf('getCreditCardStatements')).toHaveLength(1);
    expect(a.port.callsOf('getStatements')).toHaveLength(0);
    const b = setup({ accounts: [] });
    finished(await b.connector.startAuth(rt(config), ctx));
    expect(b.port.callsOf('getStatements')).toHaveLength(0);
  });

  it('a lost dialog handle (new registry) times out', async () => {
    const a = setup({ syncRequiresTan: 'decoupled' });
    const s = pending(await a.connector.startAuth(rt(config), ctx));
    const b = setup({ syncRequiresTan: 'decoupled' });
    await expect(
      b.connector.continueAuth(rt(s.dialog), { kind: 'decoupled' }, ctx),
    ).rejects.toMatchObject({ name: 'ConnectorAuthError', reason: 'timeout' });
  });

  it('a wrong answer kind is an InvalidAnswerError and keeps the dialog usable', async () => {
    const { connector } = setup({ syncRequiresTan: 'decoupled' });
    const s = pending(await connector.startAuth(rt(config), ctx));
    await expect(
      connector.continueAuth(rt(s.dialog), { kind: 'code', code: '123456' }, ctx),
    ).rejects.toBeInstanceOf(InvalidAnswerError);
    finished(await connector.continueAuth(rt(s.dialog), { kind: 'decoupled' }, ctx));
  });

  it('cancelAuth drops the session and never throws', async () => {
    const { connector, dialogs } = setup({ syncRequiresTan: 'decoupled' });
    const s = pending(await connector.startAuth(rt(config), ctx));
    await connector.cancelAuth?.(rt(s.dialog), ctx);
    await expect(
      connector.continueAuth(rt(s.dialog), { kind: 'decoupled' }, ctx),
    ).rejects.toMatchObject({ reason: 'timeout' });
    await expect(connector.cancelAuth?.({}, ctx)).resolves.toBeUndefined();
    await expect(connector.cancelAuth?.({ handle: 5 }, ctx)).resolves.toBeUndefined();
    expect(JSON.stringify(dialogs)).toContain('"size":0');
  });

  it('never leaks PIN or user id outside state.bankingInformation', async () => {
    const scenarios: ScriptedScenario[] = [
      {
        syncRequiresTan: 'decoupled',
        decoupledPendingPolls: 1,
        statementsRequireTan: true,
        accounts: [CHECKING],
      },
      { tanMethods: [pushTan], syncRequiresTan: 'code', accounts: [CHECKING] },
      { tanMethods: [photoTan], syncRequiresTan: 'photo' },
    ];
    for (const scenario of scenarios) {
      const { connector, dialogs } = setup(scenario);
      const steps: AuthStep[] = [];
      expect((await drive(connector, steps)).done).toBe(true);
      for (const step of steps) {
        const json = scrubbed(step);
        expect(json).not.toContain(PIN);
        expect(json).not.toContain(USER);
      }
      expect(JSON.stringify(dialogs)).not.toContain(PIN);
    }
    for (const failWith of ['wrong-pin', 'locked', 'server-error'] as const) {
      const { connector } = setup({ failWith });
      const err = (await connector.startAuth(rt(config), ctx).catch((e: unknown) => e)) as Error;
      expect(`${err.name}${err.message}${err.stack ?? ''}`).not.toContain(PIN);
    }
  });
});

describe('FinTS authentication: poll interval, photo gate, empty TAN', () => {
  const waiting = (first: number, between: number): FinTSTanMethod => ({
    ...decoupled,
    decoupledWait: { firstSeconds: first, betweenSeconds: between },
  });

  it('takes the poll interval from the BPD, first and later polls apart', async () => {
    const { connector } = setup({
      tanMethods: [waiting(5, 2)],
      syncRequiresTan: 'decoupled',
      decoupledPendingPolls: 2,
    });
    const first = pending(await connector.startAuth(rt(config), ctx));
    expect(first.challenge).toMatchObject({ pollAfterMs: 5000 });
    const next = pending(
      await connector.continueAuth(rt(first.dialog), { kind: 'decoupled' }, ctx),
    );
    expect(next.challenge).toMatchObject({ pollAfterMs: 2000 });
  });

  it('clamps the poll interval to 2-10 s and defaults to 3 s without a hint', async () => {
    for (const [wait, expected] of [
      [waiting(30, 30), 10000],
      [waiting(1, 1), 2000],
      [waiting(0, 0), 3000],
    ] as const) {
      const { connector } = setup({ tanMethods: [wait], syncRequiresTan: 'decoupled' });
      const s = pending(await connector.startAuth(rt(config), ctx));
      expect(s.challenge).toMatchObject({ pollAfterMs: expected });
    }
  });

  it('keeps polling the pending reference when a status response omits it', async () => {
    const { connector, port } = setup({
      syncRequiresTan: 'decoupled',
      decoupledPendingPolls: 1,
      omitPendingTanReference: true,
    });
    const first = pending(await connector.startAuth(rt(config), ctx));
    const poll = pending(
      await connector.continueAuth(rt(first.dialog), { kind: 'decoupled' }, ctx),
    );
    finished(await connector.continueAuth(rt(poll.dialog), { kind: 'decoupled' }, ctx));
    expect(port.callsOf('synchronizeWithTan').map((c) => c.args[0])).toEqual([
      'REF-SYNC',
      'REF-SYNC',
    ]);
  });

  it('only a photoTAN method gets an image challenge', async () => {
    const { connector } = setup({ tanMethods: [pushTan], syncRequiresTan: 'photo' });
    const s = pending(await connector.startAuth(rt(config), ctx));
    expect(s.challenge.kind).toBe('code');
  });

  it('rejects an empty or blank TAN before touching the session', async () => {
    const { connector, port } = setup({ tanMethods: [pushTan], syncRequiresTan: 'code' });
    const s = pending(await connector.startAuth(rt(config), ctx));
    for (const code of ['', '   ']) {
      await expect(
        connector.continueAuth(rt(s.dialog), { kind: 'code', code }, ctx),
      ).rejects.toBeInstanceOf(InvalidAnswerError);
    }
    expect(port.callsOf('synchronizeWithTan')).toHaveLength(0);
    finished(
      await connector.continueAuth(
        rt(s.dialog),
        { kind: 'code', code: SCRIPTED_CORRECT_CODE },
        ctx,
      ),
    );
  });
});

describe('FinTS authentication: transient errors keep the dialog', () => {
  it('a network error on a poll leaves the same handle usable', async () => {
    const { connector, port } = setup({
      syncRequiresTan: 'decoupled',
      pollNetworkFailures: 1,
    });
    const first = pending(await connector.startAuth(rt(config), ctx));
    const err = await connector
      .continueAuth(rt(first.dialog), { kind: 'decoupled' }, ctx)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('fints_failed');
    expect(err).not.toBeInstanceOf(ConnectorAuthError);
    finished(await connector.continueAuth(rt(first.dialog), { kind: 'decoupled' }, ctx));
    expect(port.callsOf('synchronizeWithTan')).toHaveLength(2);
  });

  it('a plain (non-port) network error also keeps the dialog', async () => {
    const { connector, port } = setup({ syncRequiresTan: 'decoupled' });
    const first = pending(await connector.startAuth(rt(config), ctx));
    const session = port.sessions[0];
    const original = session?.synchronizeWithTan.bind(session);
    let calls = 0;
    if (session && original)
      session.synchronizeWithTan = (ref, tan) => {
        if (calls++ === 0) return Promise.reject(new TypeError('fetch failed'));
        return original(ref, tan);
      };
    await expect(
      connector.continueAuth(rt(first.dialog), { kind: 'decoupled' }, ctx),
    ).rejects.toThrow('fetch failed');
    finished(await connector.continueAuth(rt(first.dialog), { kind: 'decoupled' }, ctx));
  });

  it('a failure after the bank accepted the TAN ends the dialog (no restore)', async () => {
    const { connector, dialogs } = setup({
      syncRequiresTan: 'decoupled',
      accounts: [CHECKING],
      statementsFailWith: 'network',
    });
    const first = pending(await connector.startAuth(rt(config), ctx));
    await expect(
      connector.continueAuth(rt(first.dialog), { kind: 'decoupled' }, ctx),
    ).rejects.toThrow('fints_failed');
    expect(JSON.stringify(dialogs)).toContain('"size":0');
    await expect(
      connector.continueAuth(rt(first.dialog), { kind: 'decoupled' }, ctx),
    ).rejects.toMatchObject({ name: 'ConnectorAuthError', reason: 'timeout' });
  });

  it('a terminal outcome still ends the dialog', async () => {
    const { connector } = setup({
      tanMethods: [pushTan],
      syncRequiresTan: 'code',
      correctCode: '999999',
    });
    let s = pending(await connector.startAuth(rt(config), ctx));
    for (let i = 0; i < 2; i++)
      s = pending(
        await connector.continueAuth(rt(s.dialog), { kind: 'code', code: '000000' }, ctx),
      );
    await expect(
      connector.continueAuth(rt(s.dialog), { kind: 'code', code: '000000' }, ctx),
    ).rejects.toMatchObject({ reason: 'too_many_attempts' });
    await expect(
      connector.continueAuth(rt(s.dialog), { kind: 'code', code: '999999' }, ctx),
    ).rejects.toMatchObject({ reason: 'timeout' });
  });
});

describe('FinTS authentication: statement support and the SCA probe', () => {
  const NO_STATEMENTS = { noStatementsFor: [CHECKING.accountNumber] };

  it('probes the first checking account that supports statements', async () => {
    const other = { ...CHECKING, iban: 'DE02120300000000202051', accountNumber: '202051' };
    const { connector, port } = setup({ accounts: [CHECKING, other], ...NO_STATEMENTS });
    finished(await connector.startAuth(rt(config), ctx));
    expect((port.callsOf('getStatements')[0]?.args[0] as FinTSAccount).accountNumber).toBe(
      '202051',
    );
  });

  it('falls back to a credit card that supports statements', async () => {
    const { connector, port } = setup({ accounts: [CHECKING, CARD], ...NO_STATEMENTS });
    finished(await connector.startAuth(rt(config), ctx));
    expect(port.callsOf('getStatements')).toHaveLength(0);
    expect(port.callsOf('getCreditCardStatements')).toHaveLength(1);
  });

  it('skips the probe when no account supports statements', async () => {
    const { connector, port } = setup({
      accounts: [CHECKING, CARD],
      noStatementsFor: [CHECKING.accountNumber, CARD.accountNumber],
    });
    finished(await connector.startAuth(rt(config), ctx));
    expect(port.callsOf('getStatements')).toHaveLength(0);
    expect(port.callsOf('getCreditCardStatements')).toHaveLength(0);
  });
});

describe('FinTS authentication: TAN medium', () => {
  const selected = (port: ScriptedFinTSPort) =>
    port.callsOf('selectTanMedia').map((c) => c.args[0]);

  it('selects the single active medium when required, and stores its name', async () => {
    const { connector, port } = setup({
      accounts: [CHECKING],
      tanMedia: { required: true, active: ['Mein Handy'] },
    });
    const done = finished(await connector.startAuth(rt(config), ctx));
    expect(selected(port)[0]).toBe('Mein Handy');
    expect(done.state['tanMediaName']).toBe('Mein Handy');
    // before the probe order (it goes into every HKTAN)
    const methods = port.calls.map((c) => c.method);
    expect(methods.indexOf('selectTanMedia')).toBeLessThan(methods.indexOf('getStatements'));
  });

  it('prefers the first medium when several are active (documented limitation)', async () => {
    const { connector } = setup({ tanMedia: { required: true, active: ['A', 'B'] } });
    expect(finished(await connector.startAuth(rt(config), ctx)).state['tanMediaName']).toBe('A');
  });

  it('selects nothing when no medium is required or none is active', async () => {
    for (const tanMedia of [
      { required: false, active: ['A'] },
      { required: true, active: [] },
    ]) {
      const { connector, port } = setup({ tanMedia });
      const done = finished(await connector.startAuth(rt(config), ctx));
      expect(selected(port)).toEqual([]);
      expect(done.state).not.toHaveProperty('tanMediaName');
    }
  });

  it('still stores the medium after a TAN round trip', async () => {
    const { connector } = setup({
      syncRequiresTan: 'decoupled',
      tanMedia: { required: true, active: ['Mein Handy'] },
    });
    const end = await drive(connector);
    expect(finished(end).state['tanMediaName']).toBe('Mein Handy');
  });
});

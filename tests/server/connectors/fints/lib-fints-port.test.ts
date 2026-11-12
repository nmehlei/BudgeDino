import { inspect } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FinTSPortError } from '@budgedino/server/connectors/fints/port';
import {
  LibFintsPort,
  serialiseBankingInformation,
} from '@budgedino/server/connectors/fints/lib-fints-port';

const params = {
  productId: 'PID',
  productVersion: '1.0',
  url: 'https://fints.example.invalid/fints',
  blz: '12345678',
  userId: 'user',
  pin: 'pin',
};

const info = {
  systemId: 'SYS1',
  bpd: {
    version: 1,
    countryCode: 280,
    bankId: '12345678',
    bankName: 'Test',
    maxTransactionsPerMessage: 0,
    supportedLanguages: [],
    supportedHbciVersions: [300],
    url: 'https://stale.example.invalid/fints',
    supportedTanMethods: [
      {
        id: 920,
        name: 'SecureGo plus',
        version: 7,
        isDecoupled: true,
        activeTanMediaCount: 0,
        activeTanMedia: [],
        tanMediaRequirement: 0,
        decoupled: {
          maxStatusRequests: 10,
          waitingSecondsBeforeFirstStatusRequest: 5,
          waitingSecondsBetweenStatusRequests: 2,
          manualConfirmationAllowed: false,
          autoConfirmationAllowed: true,
        },
      },
    ],
    availableTanMethodIds: [920],
    allowedTransactions: [],
  },
  bankMessages: [{ subject: 's', text: 't' }],
  upd: {
    version: 1,
    usage: 2,
    bankAccounts: [
      {
        accountNumber: '123',
        bank: { country: 280, bankId: '12345678' },
        iban: 'DE02120300000000202051',
        customerId: 'c',
        accountType: 'CheckingAccount',
        currency: 'EUR',
        holder1: 'Max',
      },
    ],
  },
};

describe('LibFintsPort', () => {
  it('opens a first-time session without network access', () => {
    const s = new LibFintsPort().openFirstTime(params);
    expect(s.accounts()).toEqual([]);
    expect(s.availableTanMethods()).toEqual([]);
  });

  it('round-trips a banking-information snapshot through JSON and openFromState', () => {
    const withDate = { ...info, bankMessages: [{ subject: 's', text: 't', at: new Date(0) }] };
    const snap = serialiseBankingInformation(withDate);
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
    expect(JSON.stringify(snap)).toContain('1970-01-01T00:00:00.000Z');
    const s = new LibFintsPort().openFromState(params, snap, 920);
    expect(s.accounts()).toMatchObject([
      {
        iban: 'DE02120300000000202051',
        accountNumber: '123',
        blz: '12345678',
        accountType: 'CheckingAccount',
      },
    ]);
    expect(s.availableTanMethods()).toMatchObject([
      { id: 920, decoupled: true, kind: 'decoupled' },
    ]);
    expect(JSON.parse(JSON.stringify(s.bankingInformation()))).toMatchObject({
      systemId: 'SYS1',
      bpd: { url: params.url },
    });
  });
});

describe('LibFintsPort error sanitising', () => {
  const CANARY = 'CANARY-PIN-9981 DE02120300000000202051';
  afterEach(() => vi.unstubAllGlobals());

  async function failure(run: () => Promise<unknown>): Promise<unknown> {
    try {
      await run();
    } catch (e) {
      return e;
    }
    throw new Error('expected a failure');
  }

  function expectClean(e: unknown, category: string) {
    expect(e).toBeInstanceOf(FinTSPortError);
    expect((e as FinTSPortError).category).toBe(category);
    expect((e as Error).cause).toBeUndefined();
    const e2 = e as Error;
    for (const text of [e2.message, e2.stack ?? '', JSON.stringify(e), inspect(e, { depth: 6 })]) {
      expect(text).not.toContain('CANARY');
      expect(text).not.toContain('DE0212');
    }
  }

  it('hides the bank response body on HTTP errors and keeps the status', async () => {
    vi.stubGlobal('fetch', async () => new Response(CANARY, { status: 503 }));
    const e = await failure(() => new LibFintsPort().openFirstTime(params).synchronize());
    expectClean(e, 'http');
    expect((e as FinTSPortError).status).toBe(503);
  });

  it('hides network error details', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed', { cause: new Error(CANARY) });
    });
    expectClean(
      await failure(() => new LibFintsPort().openFirstTime(params).synchronize()),
      'network',
    );
  });

  it('prints nothing on a decode failure and hides the response', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.stubGlobal(
      'fetch',
      async () => new Response(Buffer.from(`HNHBK:garbage${CANARY}`, 'latin1').toString('base64')),
    );
    try {
      const e = await failure(() => new LibFintsPort().openFirstTime(params).synchronize());
      expect(e).toBeInstanceOf(FinTSPortError);
      expectClean(e, (e as FinTSPortError).category);
      for (const spy of [err, warn, log, stderr, stdout]) expect(spy).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('throws a config error for a snapshot without BPD', () => {
    const noBpd = { ...info, bpd: undefined };
    expect(() => new LibFintsPort().openFromState(params, noBpd, 920)).toThrow(FinTSPortError);
    try {
      new LibFintsPort().openFromState(params, noBpd, 920);
    } catch (e) {
      expectClean(e, 'config');
    }
  });

  it('throws a config error for an unknown TAN method', () => {
    const snap = serialiseBankingInformation(info);
    expect(() => new LibFintsPort().openFromState(params, snap, 111)).toThrow(FinTSPortError);
  });

  it('reports a stored URL that differs from the catalog, with the BLZ only', () => {
    const seen: string[] = [];
    const port = new LibFintsPort({ onUrlMismatch: (blz) => seen.push(blz) });
    port.openFromState(params, serialiseBankingInformation(info), 920);
    expect(seen).toEqual(['12345678']);
    const same = { ...info, bpd: { ...info.bpd, url: params.url } };
    port.openFromState(params, serialiseBankingInformation(same), 920);
    expect(seen).toHaveLength(1);
  });
});

describe('LibFintsPort statement parse failures (P2-R5)', () => {
  afterEach(() => vi.restoreAllMocks());

  type Handler = { handleResponse(r: unknown, c: Record<string, unknown>): void };

  // The interaction classes are not exported by lib-fints; load the patched files by path.
  async function handlerFor(file: string, ctor: string): Promise<Handler> {
    const dist = new URL('../../../../src/server/node_modules/lib-fints/dist/', import.meta.url);
    const target = pathToFileURL(fileURLToPath(new URL(`interactions/${file}`, dist)));
    const mod = (await import(target.href)) as Record<string, new (...a: unknown[]) => Handler>;
    const Cls = mod[ctor] as new (...a: unknown[]) => Handler;
    return new Cls({}, undefined, undefined);
  }

  const fakeResponse = (segment: unknown) => ({ findAllSegments: () => [segment] });

  it('the patched MT940 interaction flags a payload that does not parse', async () => {
    const handler = await handlerFor('statementInteractionMT940.js', 'StatementInteractionMT940');
    const bad: Record<string, unknown> = {};
    handler.handleResponse(fakeResponse({ bookedTransactions: ':61:garbage-without-60F' }), bad);
    expect(bad['parseFailed']).toBe(true);
    const empty: Record<string, unknown> = {};
    handler.handleResponse(fakeResponse({}), empty);
    expect(empty['parseFailed']).toBeUndefined();
    expect(empty['statements']).toEqual([]);
  });

  it('the patched CAMT interaction flags a payload that does not parse', async () => {
    const handler = await handlerFor('statementInteractionCAMT.js', 'StatementInteractionCAMT');
    const bad: Record<string, unknown> = {};
    handler.handleResponse(fakeResponse({ bookedTransactions: ['<not-camt/>'] }), bad);
    expect(bad['parseFailed']).toBe(true);
  });

  const account = {
    iban: 'DE02120300000000202051',
    accountNumber: '123',
    blz: '12345678',
    accountType: 'CheckingAccount' as const,
  };
  const okResponse = {
    success: true,
    requiresTan: false,
    bankAnswers: [],
    bankingInformationUpdated: false,
    dialogId: 'd',
    statements: [],
  };

  /** A session over a lib-fints client whose bank calls are replaced by `stubs`. */
  function stubbed(stubs: Record<string, () => Promise<unknown>>) {
    return new LibFintsPort({
      onClientCreated: (c) => Object.assign(c, stubs),
    }).openFromState(params, serialiseBankingInformation(info), 920);
  }

  it('surfaces a parseFailed response as a decode error instead of zero statements', async () => {
    const session = stubbed({
      getAccountStatements: () => Promise.resolve({ ...okResponse, parseFailed: true }),
    });
    const e = await session.getStatements(account).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(FinTSPortError);
    expect((e as FinTSPortError).category).toBe('decode');
  });

  it('takes the balance from the last statement closing balance, no extra order', async () => {
    const session = stubbed({
      getAccountStatements: () =>
        Promise.resolve({
          ...okResponse,
          statements: [
            { transactions: [], closingBalance: { date: new Date(0), currency: 'EUR', value: 1 } },
            {
              transactions: [],
              closingBalance: { date: new Date(0), currency: 'EUR', value: -7.25 },
            },
          ],
        }),
    });
    await expect(session.getStatements(account)).resolves.toMatchObject({
      balance: { value: -7.25, currency: 'EUR' },
    });
  });

  it('takes the credit card balance from the statements response', async () => {
    const session = stubbed({
      getCreditCardStatements: () =>
        Promise.resolve({
          ...okResponse,
          balance: { balance: -99.5, date: new Date(0), currency: 'EUR' },
        }),
    });
    await expect(session.getCreditCardStatements(account)).resolves.toMatchObject({
      balance: { value: -99.5, currency: 'EUR' },
    });
  });

  it('still returns genuinely empty statements as success', async () => {
    const session = stubbed({ getAccountStatements: () => Promise.resolve(okResponse) });
    await expect(session.getStatements(account)).resolves.toMatchObject({
      success: true,
      transactions: [],
    });
  });
});

describe('LibFintsPort catalog URL pin (P2-R4)', () => {
  const evil = 'https://evil.example.invalid/fints';
  const okResponse = {
    success: true,
    requiresTan: false,
    bankAnswers: [],
    bankingInformationUpdated: true,
    dialogId: 'd',
    statements: [],
  };
  const account = {
    iban: 'DE02120300000000202051',
    accountNumber: '123',
    blz: '12345678',
    accountType: 'CheckingAccount' as const,
  };

  type Cfg = {
    bankingInformation: { bpd?: Record<string, unknown>; upd?: unknown };
    bankingUrl: string;
  };
  type StubClient = {
    config: Cfg;
    synchronize: () => Promise<unknown>;
    getAccountStatements: () => Promise<unknown>;
  };

  /** A port whose clients behave like lib-fints when the bank answers HIKOM with another address. */
  function hikomPort() {
    const mismatches: string[] = [];
    const urlsAtOrder: string[] = [];
    const port = new LibFintsPort({
      onUrlMismatch: (blz) => mismatches.push(blz),
      onClientCreated: (c) => {
        const client = c as unknown as StubClient;
        client.synchronize = () => {
          client.config.bankingInformation.bpd = { ...info.bpd, url: evil };
          client.config.bankingInformation.upd = info.upd;
          return Promise.resolve(okResponse);
        };
        client.getAccountStatements = () => {
          urlsAtOrder.push(client.config.bankingUrl);
          // The order dialog's own init handles HIKOM again.
          client.config.bankingInformation.bpd = { ...info.bpd, url: evil };
          return Promise.resolve(okResponse);
        };
      },
    });
    return { port, mismatches, urlsAtOrder };
  }

  it('keeps the catalog URL after a sync whose HIKOM names another address', async () => {
    const { port, mismatches } = hikomPort();
    const session = port.openFirstTime(params);
    const r = await session.synchronize();
    expect((r.bankingInformation as { bpd: { url: string } }).bpd.url).toBe(params.url);
    expect((session.bankingInformation() as { bpd: { url: string } }).bpd.url).toBe(params.url);
    await session.synchronize();
    expect(mismatches).toEqual(['12345678']);
  });

  it('sends every order to the catalog URL and stores the pinned URL', async () => {
    const { port, mismatches, urlsAtOrder } = hikomPort();
    const session = port.openFirstTime(params);
    await session.synchronize();
    // lib-fints would now read the announced address; the session must have rewritten it.
    await session.getStatements(account).catch(() => undefined);
    await session.getStatements(account).catch(() => undefined);
    expect(urlsAtOrder).toEqual([params.url, params.url]);
    expect((session.bankingInformation() as { bpd: { url: string } }).bpd.url).toBe(params.url);
    expect(mismatches).toHaveLength(1);
  });
});

describe('LibFintsPort statement support, TAN media and polling hints', () => {
  const card = {
    accountNumber: '123',
    blz: '12345678',
    accountType: 'CreditCardAccount' as const,
    iban: 'DE02120300000000202051',
  };
  const okResponse = {
    success: true,
    requiresTan: false,
    bankAnswers: [],
    bankingInformationUpdated: false,
    dialogId: 'd',
    statements: [],
  };
  const withCard = serialiseBankingInformation({
    ...info,
    upd: {
      ...info.upd,
      bankAccounts: [{ ...info.upd.bankAccounts[0], accountType: 'CreditCardAccount' }],
    },
  });

  function open(stubs: Record<string, unknown>, state: unknown = withCard) {
    return new LibFintsPort({ onClientCreated: (c) => Object.assign(c, stubs) }).openFromState(
      params,
      state,
      920,
    );
  }

  it('canGetStatements follows the account or credit card path', () => {
    const yes = () => true;
    const no = () => false;
    expect(
      open({ canGetCreditCardStatements: no, canGetAccountStatements: yes }).canGetStatements(card),
    ).toBe(true);
    expect(
      open({ canGetCreditCardStatements: yes, canGetAccountStatements: no }).canGetStatements(card),
    ).toBe(true);
    expect(
      open({ canGetCreditCardStatements: no, canGetAccountStatements: no }).canGetStatements(card),
    ).toBe(false);
    expect(open({}).canGetStatements({ ...card, iban: 'DE00000000000000000000' })).toBe(false);
  });

  it('a credit card without card statements but with account statements uses getStatements', async () => {
    const calls: string[] = [];
    const session = open({
      canGetCreditCardStatements: () => false,
      canGetAccountStatements: () => true,
      getAccountStatements: () => {
        calls.push('account');
        return Promise.resolve(okResponse);
      },
      getCreditCardStatements: () => {
        calls.push('card');
        return Promise.resolve(okResponse);
      },
    });
    await session.getCreditCardStatements(card);
    expect(calls).toEqual(['account']);
  });

  it('exposes the TAN medium needs and selects a medium', () => {
    const base = serialiseBankingInformation(info) as typeof info;
    const state = {
      ...base,
      bpd: {
        ...base.bpd,
        supportedTanMethods: [
          { ...base.bpd.supportedTanMethods[0], tanMediaRequirement: 2, activeTanMedia: ['M1'] },
        ],
      },
    };
    const session = new LibFintsPort().openFromState(params, state, 920, 'M1');
    expect(session.tanMedia()).toEqual({ required: true, active: ['M1'] });
    expect(() => session.selectTanMedia('M1')).not.toThrow();
    expect(() => session.selectTanMedia('unknown')).toThrow(FinTSPortError);
    expect(() => new LibFintsPort().openFromState(params, state, 920, 'nope')).toThrow(
      FinTSPortError,
    );
    const none = new LibFintsPort().openFromState(params, base, 920);
    expect(none.tanMedia()).toEqual({ required: false, active: [] });
  });

  it('maps the decoupled polling hints of the BPD', () => {
    const session = new LibFintsPort().openFromState(
      params,
      serialiseBankingInformation(info),
      920,
    );
    expect(session.availableTanMethods()[0]?.decoupledWait).toEqual({
      firstSeconds: 5,
      betweenSeconds: 2,
    });
  });

  it('flags a response that fell back to the dialog init as initFailed', async () => {
    const session = open(
      {
        canGetAccountStatements: () => true,
        getAccountStatements: () =>
          Promise.resolve({ ...okResponse, success: false, initFailed: true }),
      },
      serialiseBankingInformation(info),
    );
    const r = await session.getStatements({
      iban: 'DE02120300000000202051',
      accountNumber: '123',
      blz: '12345678',
      accountType: 'CheckingAccount',
    });
    expect(r.initFailed).toBe(true);
  });
});

describe('LibFintsPort dialog init rejection (patched lib-fints)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('marks an order whose dialog init was rejected by the bank as initFailed', async () => {
    const wire =
      "HNHBK:1:3+000000000000+300+0+1'HIRMG:2:2+9050::Nachricht enthaelt Fehler'HNHBS:3:1+1'";
    vi.stubGlobal(
      'fetch',
      async () => new Response(Buffer.from(wire, 'latin1').toString('base64')),
    );
    const base = serialiseBankingInformation(info) as typeof info;
    const state = {
      ...base,
      bpd: {
        ...base.bpd,
        allowedTransactions: [{ transId: 'HKKAZ', tanRequired: false, versions: [7] }],
      },
      upd: {
        ...base.upd,
        bankAccounts: [
          {
            ...base.upd.bankAccounts[0],
            allowedTransactions: [{ transId: 'HKKAZ', requiredSignatures: 1 }],
          },
        ],
      },
    };
    const session = new LibFintsPort().openFromState(params, state, 920);
    const r = await session.getStatements({
      iban: 'DE02120300000000202051',
      accountNumber: '123',
      blz: '12345678',
      accountType: 'CheckingAccount',
    });
    expect(r.success).toBe(false);
    expect(r.initFailed).toBe(true);
    expect(r.bankAnswers.map((a) => a.code)).toEqual([9050]);
  });
});

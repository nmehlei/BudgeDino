import { inspect } from 'node:util';
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

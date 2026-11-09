import { describe, expect, it } from 'vitest';
import { createLogger } from '@budgedino/server/observability/logger';
import { createFinTSConnector } from '@budgedino/server/connectors/fints/connector';
import { FinTSDialogRegistry } from '@budgedino/server/connectors/fints/dialogs';
import {
  LibFintsPort,
  serialiseBankingInformation,
} from '@budgedino/server/connectors/fints/lib-fints-port';
import {
  FinTSPortError,
  type FinTSAccount,
  type FinTSPort,
  type FinTSSession,
  type FinTSTx,
} from '@budgedino/server/connectors/fints/port';
import type {
  Connector,
  ConnectorContext,
  ConnectorState,
  FetchResult,
} from '@budgedino/server/connectors/types';
import { TEST_ZONES, withTimeZone, wireIso } from '../../../support/fints/lib-fints-dist';
import { ScriptedFinTSPort, type ScriptedScenario } from '../../../support/fints/scripted-port';

const PIN = 'PIN-CANARY-7731';
const USER = 'USER-CANARY-4412';
const NOW = new Date('2026-11-09T10:00:00.000Z');
const config = { bank: 'dkb', userId: USER, pin: PIN } as const;

const ctxAt = (now: Date): ConnectorContext => ({
  now: () => now,
  userPresent: false,
  logger: createLogger({ level: 'silent' }),
});
const ctx = ctxAt(NOW);

const IBAN = 'DE89370400440532013000';
const CHECKING: FinTSAccount = {
  iban: IBAN,
  accountNumber: '532013000',
  blz: '12030000',
  accountType: 'CheckingAccount',
  currency: 'EUR',
  product: 'Girokonto',
};
const CARD: FinTSAccount = {
  accountNumber: '4111',
  subAccountId: '01',
  blz: '12030000',
  accountType: 'CreditCardAccount',
  currency: 'EUR',
};
const DEPOT: FinTSAccount = {
  accountNumber: '777',
  subAccountId: '00',
  blz: '12030000',
  accountType: 'SecuritiesAccount',
  currency: 'EUR',
};
const CARD_REF = '4111:01:12030000';
const DEPOT_REF = '777:00:12030000';

const tx = (over: Partial<FinTSTx> = {}): FinTSTx => ({
  valueDate: '2026-11-03',
  bookingDate: '2026-11-02',
  amount: -12.5,
  purpose: 'Coffee',
  remoteName: 'Cafe',
  ...over,
});

const rt = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

async function setup(
  scenario: ScriptedScenario,
  port: FinTSPort = new ScriptedFinTSPort(scenario),
) {
  const scripted = port instanceof ScriptedFinTSPort ? port : undefined;
  // Authenticate against a bank that behaves; the fetch-time problems apply afterwards.
  const later = {
    statementsRequireTan: scenario.statementsRequireTan,
    statementsFailWith: scenario.statementsFailWith,
    statementsAnswerCode: scenario.statementsAnswerCode,
  };
  if (scripted) {
    delete scripted.scenario.statementsRequireTan;
    delete scripted.scenario.statementsFailWith;
    delete scripted.scenario.statementsAnswerCode;
  }
  const dialogs = new FinTSDialogRegistry({ now: ctx.now });
  const real = createFinTSConnector({ port, dialogs, product: { id: 'PID', version: '1.0' } });
  // The server passes the decrypted config on every call; default to it here.
  const connector: Connector = {
    ...real,
    listAccounts: (st, c, cfg = config) => real.listAccounts(st, c, cfg),
    fetchTransactions: (st, ref, since, c, cfg = config) =>
      real.fetchTransactions(st, ref, since, c, cfg),
  };
  const auth = await connector.startAuth(rt(config), ctx);
  if (!auth.done) throw new Error('expected done');
  const state: ConnectorState = rt(auth.state);
  if (scripted) Object.assign(scripted.scenario, later);
  scripted?.calls.splice(0);
  return { port, scripted, dialogs, connector, state };
}

const failure = (r: FetchResult) => {
  if (r.ok) throw new Error('expected failure');
  return r;
};
const success = (r: FetchResult) => {
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
  return r;
};

describe('FinTS listAccounts', () => {
  it('maps UPD accounts with stable, unique refs and no network access', async () => {
    const { connector, scripted, state } = await setup({ accounts: [CHECKING, CARD, DEPOT] });
    const first = await connector.listAccounts(state, ctx);
    const second = await connector.listAccounts(state, ctx);
    expect(first).toEqual(second);
    expect(first.map((a) => [a.ref, a.kind])).toEqual([
      [IBAN, 'checking'],
      [CARD_REF, 'credit_card'],
      [DEPOT_REF, 'depot'],
    ]);
    expect(scripted?.calls.map((c) => c.method)).toEqual(['openFromState', 'openFromState']);
    expect(scripted?.callsOf('openFromState')[0]?.args[0]).toMatchObject({
      userId: USER,
      pin: PIN,
      url: 'https://fints.dkb.de/fints',
      blz: '12030000',
    });
    expect(scripted?.callsOf('openFromState')[0]?.args[2]).toBe(920);
  });
});

describe('FinTS fetchTransactions', () => {
  it('requests exactly 89 days on the first sync, in the bank calendar', async () => {
    const { connector, scripted, state } = await setup({ accounts: [CHECKING] });
    success(await connector.fetchTransactions(state, IBAN, null, ctx));
    const call = scripted?.callsOf('getStatements')[0];
    expect(wireIso(call?.args[1])).toBe('2026-08-12');
    expect(wireIso(call?.args[2])).toBe('2026-11-09');
  });

  it('uses the Europe/Berlin date, not the UTC or host date', async () => {
    const { connector, scripted, state } = await setup({ accounts: [CHECKING] });
    // 23:30 UTC on 9 Nov is already 10 Nov in Berlin (CET).
    await connector.fetchTransactions(state, IBAN, null, ctxAt(new Date('2026-11-09T23:30:00Z')));
    const call = scripted?.callsOf('getStatements')[0];
    expect(wireIso(call?.args[2])).toBe('2026-11-10');
    expect(wireIso(call?.args[1])).toBe('2026-08-13');
    // 22:30 UTC on 30 Mar is 00:30 on 31 Mar in Berlin (CEST).
    await connector.fetchTransactions(state, IBAN, null, ctxAt(new Date('2026-03-30T22:30:00Z')));
    expect(wireIso(scripted?.callsOf('getStatements')[1]?.args[2])).toBe('2026-03-31');
  });

  it('honours since, but never reaches beyond 89 days', async () => {
    const { connector, scripted, state } = await setup({ accounts: [CHECKING] });
    await connector.fetchTransactions(state, IBAN, new Date('2026-10-01T00:00:00Z'), ctx);
    await connector.fetchTransactions(state, IBAN, new Date('2025-01-01T00:00:00Z'), ctx);
    const calls = scripted?.callsOf('getStatements') ?? [];
    expect(wireIso(calls[0]?.args[1])).toBe('2026-10-01');
    expect(wireIso(calls[1]?.args[1])).toBe('2026-08-12');
  });

  it('maps transactions and balance', async () => {
    const { connector, state } = await setup({
      accounts: [CHECKING],
      transactions: [tx(), tx({ amount: 1000.1 })],
      balance: { value: 1234.56, currency: 'EUR' },
    });
    const r = success(await connector.fetchTransactions(state, IBAN, null, ctx));
    expect(r.transactions).toHaveLength(2);
    expect(r.transactions[0]).toMatchObject({
      status: 'booked',
      bookingDate: '2026-11-02',
      valueDate: '2026-11-03',
      amount: { minor: -1250n, currency: 'EUR' },
      counterparty: 'Cafe',
    });
    expect(r.transactions[1]?.amount.minor).toBe(100010n);
    expect(r.balance).toEqual({ minor: 123456n, currency: 'EUR' });
    expect(r.state).toBeUndefined();
  });

  it('uses the credit card path for credit accounts', async () => {
    const { connector, scripted, state } = await setup({
      accounts: [CHECKING, CARD],
      creditCardTransactions: [tx({ amount: -5 })],
      transactions: [tx({ amount: -99 })],
    });
    const r = success(await connector.fetchTransactions(state, CARD_REF, null, ctx));
    expect(r.transactions.map((t) => t.amount.minor)).toEqual([-500n]);
    expect(scripted?.callsOf('getStatements')).toHaveLength(0);
    expect(wireIso(scripted?.callsOf('getCreditCardStatements')[0]?.args[1])).toBe('2026-08-12');
  });

  it('returns an empty ok result for depots without asking the bank for statements', async () => {
    const { connector, scripted, state } = await setup({ accounts: [DEPOT] });
    const r = success(await connector.fetchTransactions(state, DEPOT_REF, null, ctx));
    expect(r.transactions).toEqual([]);
    expect(scripted?.callsOf('getStatements')).toHaveLength(0);
    expect(scripted?.callsOf('getCreditCardStatements')).toHaveLength(0);
  });

  it('a TAN demand becomes needs_attention without a dialog or an exception', async () => {
    const { connector, dialogs, state } = await setup({
      accounts: [CHECKING],
      statementsRequireTan: true,
    });
    const r = failure(await connector.fetchTransactions(state, IBAN, null, ctx));
    expect(r.reason).toBe('needs_attention');
    expect(r.state).toBeUndefined();
    expect(JSON.stringify(dialogs)).toContain('"size":0');
  });

  it('a PIN error becomes needs_attention', async () => {
    const { connector, state } = await setup({
      accounts: [CHECKING],
      statementsFailWith: 'wrong-pin',
    });
    expect(failure(await connector.fetchTransactions(state, IBAN, null, ctx)).reason).toBe(
      'needs_attention',
    );
  });

  it('bank-side network, 5xx and decode problems are temporary', async () => {
    for (const statementsFailWith of ['server-error', 'decode'] as const) {
      const { connector, state } = await setup({ accounts: [CHECKING], statementsFailWith });
      const r = failure(await connector.fetchTransactions(state, IBAN, null, ctx));
      expect(r.reason).toBe('temporary');
      expect(r.state).toBeUndefined();
    }
  });

  it('issues exactly one bank order per fetch and takes the balance from it', async () => {
    for (const [account, ref] of [
      [CHECKING, IBAN],
      [CARD, CARD_REF],
    ] as const) {
      const { connector, scripted, state } = await setup({
        accounts: [CHECKING, CARD],
        balance: { value: -42.1, currency: 'EUR' },
      });
      const r = success(await connector.fetchTransactions(state, ref, null, ctx));
      expect(account.accountType).toBeDefined();
      expect(scripted?.calls.map((c) => c.method)).toEqual([
        'openFromState',
        account === CARD ? 'getCreditCardStatements' : 'getStatements',
      ]);
      expect(r.balance).toEqual({ minor: -4210n, currency: 'EUR' });
    }
  });

  it('routes accounts sharing an account number (no IBAN) by sub-account', async () => {
    const a: FinTSAccount = { ...DEPOT, accountType: 'CheckingAccount', subAccountId: '10' };
    const b: FinTSAccount = { ...DEPOT, accountType: 'CreditCardAccount', subAccountId: '20' };
    const { connector, scripted, state } = await setup({
      accounts: [a, b],
      transactions: [tx({ amount: -1 })],
      creditCardTransactions: [tx({ amount: -2 })],
    });
    const listed = await connector.listAccounts(state, ctx);
    expect(listed.map((x) => x.ref)).toEqual(['777:10:12030000', '777:20:12030000']);
    const ra = success(await connector.fetchTransactions(state, '777:10:12030000', null, ctx));
    const rb = success(await connector.fetchTransactions(state, '777:20:12030000', null, ctx));
    expect(ra.transactions[0]?.amount.minor).toBe(-100n);
    expect(rb.transactions[0]?.amount.minor).toBe(-200n);
    expect((scripted?.callsOf('getStatements')[0]?.args[0] as FinTSAccount).subAccountId).toBe(
      '10',
    );
    expect(
      (scripted?.callsOf('getCreditCardStatements')[0]?.args[0] as FinTSAccount).subAccountId,
    ).toBe('20');
  });

  it('sends UTC-midnight dates that encode to the Berlin calendar day, on any host zone', async () => {
    for (const tz of TEST_ZONES) {
      await withTimeZone(tz, async () => {
        const { connector, scripted, state } = await setup({ accounts: [CHECKING, CARD] });
        await connector.fetchTransactions(state, IBAN, null, ctx);
        await connector.fetchTransactions(state, CARD_REF, null, ctx);
        // 23:30 UTC on 9 Nov is already 10 Nov in Berlin.
        await connector.fetchTransactions(
          state,
          IBAN,
          null,
          ctxAt(new Date('2026-11-09T23:30:00Z')),
        );
        const stmts = scripted?.callsOf('getStatements') ?? [];
        expect([wireIso(stmts[0]?.args[1]), wireIso(stmts[0]?.args[2])], tz).toEqual([
          '2026-08-12',
          '2026-11-09',
        ]);
        expect(wireIso(scripted?.callsOf('getCreditCardStatements')[0]?.args[1]), tz).toBe(
          '2026-08-12',
        );
        expect([wireIso(stmts[1]?.args[1]), wireIso(stmts[1]?.args[2])], tz).toEqual([
          '2026-08-13',
          '2026-11-10',
        ]);
      });
    }
  });

  it('returns a refreshed bankingInformation in the state', async () => {
    const updated = { systemId: 'SYS-NEW', bpd: { url: 'https://fints.example.invalid/x' } };
    const { connector, state } = await setup({
      accounts: [CHECKING],
      bankingInformationAfterStatements: updated,
    });
    const r = success(await connector.fetchTransactions(state, IBAN, null, ctx));
    expect(r.state).toEqual({ ...state, bankingInformation: updated });
  });

  it('returns refreshed bankingInformation on failure paths too', async () => {
    const updated = { systemId: 'SYS-NEW', bpd: { url: 'https://fints.example.invalid/x' } };
    const { connector, state } = await setup({
      accounts: [CHECKING],
      bankingInformationAfterStatements: updated,
      statementsRequireTan: true,
    });
    const r = failure(await connector.fetchTransactions(state, IBAN, null, ctx));
    expect(r.reason).toBe('needs_attention');
    expect(r.state).toEqual({ ...state, bankingInformation: updated });
  });

  it('an unknown account ref needs attention', async () => {
    const { connector, state } = await setup({ accounts: [CHECKING] });
    expect(failure(await connector.fetchTransactions(state, 'NOPE', null, ctx)).reason).toBe(
      'needs_attention',
    );
  });

  it('a missing or invalid config, or an unusable state, needs attention', async () => {
    const { connector, state, scripted } = await setup({ accounts: [CHECKING] });
    for (const cfg of [{}, { bank: 'dkb' }, { ...config, extra: 1 }]) {
      const r = failure(await connector.fetchTransactions(state, IBAN, null, ctx, cfg));
      expect(r.reason).toBe('needs_attention');
    }
    expect(failure(await connector.fetchTransactions({}, IBAN, null, ctx)).reason).toBe(
      'needs_attention',
    );
    expect(scripted?.calls).toHaveLength(0);
  });

  describe('opening the stored session', () => {
    class OpenFails extends ScriptedFinTSPort {
      armed = false;
      constructor(private readonly err: unknown) {
        super({ accounts: [CHECKING] });
      }
      override openFromState(...args: Parameters<FinTSPort['openFromState']>): FinTSSession {
        if (this.armed) throw this.err;
        return super.openFromState(...args);
      }
    }
    async function withFailure(err: unknown) {
      const port = new OpenFails(err);
      const s = await setup({}, port);
      port.armed = true;
      return s;
    }

    it('a config error (corrupt BPD) needs attention', async () => {
      const { connector, state } = await withFailure(new FinTSPortError('config'));
      const r = failure(await connector.fetchTransactions(state, IBAN, null, ctx));
      expect(r.reason).toBe('needs_attention');
      expect(r.state).toBeUndefined();
    });

    it('other port errors are temporary', async () => {
      const { connector, state } = await withFailure(new FinTSPortError('unknown'));
      expect(failure(await connector.fetchTransactions(state, IBAN, null, ctx)).reason).toBe(
        'temporary',
      );
    });

    it('unexpected exceptions propagate', async () => {
      const { connector, state } = await withFailure(new RangeError('boom'));
      await expect(connector.fetchTransactions(state, IBAN, null, ctx)).rejects.toThrow('boom');
    });
  });
});

describe('FinTS done-state round trip into LibFintsPort', () => {
  const realistic = {
    systemId: 'SYS-REAL',
    bpd: {
      version: 9,
      countryCode: 280,
      bankId: '12030000',
      bankName: 'DKB',
      maxTransactionsPerMessage: 0,
      supportedLanguages: [1],
      supportedHbciVersions: [300],
      url: 'https://fints.dkb.de/fints',
      supportedTanMethods: [
        {
          id: 920,
          name: 'DKB App',
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
    // A Date inside the snapshot must not break JSON-safety.
    bankMessages: [{ subject: 's', text: 't', at: new Date(Date.UTC(2026, 10, 1)) }],
    upd: {
      version: 3,
      usage: 2,
      bankAccounts: [
        {
          accountNumber: '532013000',
          bank: { country: 280, bankId: '12030000' },
          iban: IBAN,
          customerId: 'c1',
          accountType: 'CheckingAccount',
          currency: 'EUR',
          holder1: 'Max',
          product: 'Girokonto',
          allowedTransactions: [{ transactionType: 'HKKAZ', requiredSignatures: 1 }],
        },
      ],
    },
  };

  it('survives JSON and reopens a usable session', async () => {
    const { state } = await setup({
      accounts: [CHECKING],
      bankingInformation: serialiseBankingInformation(realistic),
    });
    expect(JSON.stringify(state)).toContain('2026-11-01T00:00:00.000Z');
    const reopened = new LibFintsPort().openFromState(
      {
        productId: 'PID',
        productVersion: '1.0',
        url: 'https://fints.dkb.de/fints',
        blz: '12030000',
        userId: USER,
        pin: PIN,
      },
      state['bankingInformation'],
      state['tanMethodId'] as number,
    );
    expect(reopened.accounts()).toMatchObject([
      { iban: IBAN, accountType: 'CheckingAccount', blz: '12030000' },
    ]);
    expect(reopened.availableTanMethods()).toMatchObject([{ id: 920, kind: 'decoupled' }]);
    expect(rt(reopened.bankingInformation())).toEqual(rt(state['bankingInformation']));
  });
});

describe('FinTS statement support', () => {
  it('lists only accounts with statement support, depots always', async () => {
    const savings: FinTSAccount = {
      accountNumber: '999',
      blz: '12030000',
      accountType: 'SavingsAccount',
      currency: 'EUR',
    };
    const { connector, state } = await setup({
      accounts: [CHECKING, savings, CARD, DEPOT],
      noStatementsFor: ['999', '4111', '777'],
    });
    const list = await connector.listAccounts(state, ctx);
    expect(list.map((a) => a.kind)).toEqual(['checking', 'depot']);
  });

  it('an unsupported statements call is an empty success, not a failure', async () => {
    const { connector, state } = await setup({
      accounts: [CHECKING],
      noStatementsFor: [CHECKING.accountNumber],
    });
    const r = success(await connector.fetchTransactions(state, IBAN, null, ctx));
    expect(r.transactions).toEqual([]);
  });
});

describe('FinTS lockout protection on fetch', () => {
  it('a rejected dialog init is needs_attention, never temporary', async () => {
    const { connector, state } = await setup({
      accounts: [CHECKING],
      statementsFailWith: 'init-failed',
    });
    expect(failure(await connector.fetchTransactions(state, IBAN, null, ctx)).reason).toBe(
      'needs_attention',
    );
  });

  it('answer codes 9930-9942 and 3938 are needs_attention; other failures stay temporary', async () => {
    for (const code of [9930, 9931, 9935, 9942, 3938]) {
      const { connector, state } = await setup({
        accounts: [CHECKING],
        statementsAnswerCode: code,
      });
      expect(failure(await connector.fetchTransactions(state, IBAN, null, ctx)).reason).toBe(
        'needs_attention',
      );
    }
    for (const code of [9050, 9800, 9943]) {
      const { connector, state } = await setup({
        accounts: [CHECKING],
        statementsAnswerCode: code,
      });
      expect(failure(await connector.fetchTransactions(state, IBAN, null, ctx)).reason).toBe(
        'temporary',
      );
    }
  });
});

describe('FinTS TAN medium on reopen', () => {
  it('passes the stored medium name to the port and rejects a malformed one', async () => {
    const { connector, scripted, state } = await setup({
      accounts: [CHECKING],
      tanMedia: { required: true, active: ['Mein Handy'] },
    });
    expect(state['tanMediaName']).toBe('Mein Handy');
    success(await connector.fetchTransactions(state, IBAN, null, ctx));
    expect(scripted?.callsOf('openFromState').at(-1)?.args[3]).toBe('Mein Handy');
    const bad = { ...state, tanMediaName: 5 };
    expect(failure(await connector.fetchTransactions(bad, IBAN, null, ctx)).reason).toBe(
      'needs_attention',
    );
  });
});

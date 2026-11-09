import { describe, expect, it } from 'vitest';
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

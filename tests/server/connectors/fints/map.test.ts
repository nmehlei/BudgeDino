import { afterEach, describe, expect, it } from 'vitest';
import { currencyExponent } from '@budgedino/shared';
import {
  classifyTanMethod,
  mapAccount,
  mapTx,
  toIsoDate,
  toMinor,
} from '@budgedino/server/connectors/fints/map';
import type { FinTSAccount, FinTSTx } from '@budgedino/server/connectors/fints/port';

const acc = (over: Partial<FinTSAccount> = {}): FinTSAccount => ({
  accountNumber: '1234567',
  blz: '12030000',
  accountType: 'CheckingAccount',
  currency: 'EUR',
  holder1: 'Max Mustermann',
  ...over,
});

describe('currencyExponent', () => {
  it('defaults to 2 and knows zero-decimal currencies', () => {
    expect(currencyExponent('EUR')).toBe(2);
    expect(currencyExponent('JPY')).toBe(0);
    expect(currencyExponent('KRW')).toBe(0);
    expect(currencyExponent('ISK')).toBe(0);
  });
});

describe('toMinor', () => {
  it('maps float artefacts and fractions exactly', () => {
    expect(toMinor(-0.1 + -0.2, 'EUR')).toBe(-30n);
    expect(toMinor(1234.5, 'EUR')).toBe(123450n);
    expect(toMinor(-0.07, 'EUR')).toBe(-7n);
    expect(toMinor(0, 'EUR')).toBe(0n);
  });
  it('respects the currency exponent', () => {
    expect(toMinor(100, 'JPY')).toBe(100n);
  });
  it('rejects NaN and Infinity', () => {
    expect(() => toMinor(NaN, 'EUR')).toThrow();
    expect(() => toMinor(Infinity, 'EUR')).toThrow();
    expect(() => toMinor(-Infinity, 'EUR')).toThrow();
  });
});

describe('toIsoDate', () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it('formats local calendar date', () => {
    expect(toIsoDate(new Date(2026, 10, 15))).toBe('2026-11-15');
    expect(toIsoDate(new Date(2026, 0, 1))).toBe('2026-01-01');
  });

  // Node re-reads process.env.TZ on assignment; vitest runs tests in forked processes. The offset
  // assertion proves the zone actually changed, so the test cannot pass vacuously.
  it.each([
    ['Pacific/Kiritimati', -840],
    ['America/Los_Angeles', 480],
  ])('keeps the lib-fints local-midnight day under TZ=%s', (tz, offset) => {
    process.env.TZ = tz;
    const d = new Date(2026, 10, 15);
    expect(d.getTimezoneOffset()).toBe(offset);
    expect(toIsoDate(d)).toBe('2026-11-15');
    expect(toIsoDate(new Date(2026, 11, 31))).toBe('2026-12-31');
  });
});

describe('mapTx', () => {
  const base: FinTSTx = {
    valueDate: new Date(2026, 10, 16),
    entryDate: new Date(2026, 10, 15),
    amount: -12.34,
    remoteName: 'REWE',
    purpose: 'Einkauf',
  };
  it('maps fields', () => {
    expect(mapTx(base, 'EUR')).toEqual({
      providerId: null,
      status: 'booked',
      bookingDate: '2026-11-15',
      valueDate: '2026-11-16',
      amount: { minor: -1234n, currency: 'EUR' },
      counterparty: 'REWE',
      purpose: 'Einkauf',
    });
  });
  it('sets counterpartyIban only for IBAN-shaped remote account numbers', () => {
    expect(
      mapTx({ ...base, remoteAccountNumber: 'DE89370400440532013000' }, 'EUR').counterpartyIban,
    ).toBe('DE89370400440532013000');
    expect(mapTx({ ...base, remoteAccountNumber: '1234567' }, 'EUR')).not.toHaveProperty(
      'counterpartyIban',
    );
  });
});

describe('mapAccount', () => {
  it('uses the IBAN as ref', () => {
    const m = mapAccount(acc({ iban: 'DE89370400440532013000' }));
    expect(m.ref).toBe('DE89370400440532013000');
    expect(m.iban).toBe('DE89370400440532013000');
  });
  it('gives accounts sharing a number distinct, stable refs', () => {
    const a = mapAccount(acc({ subAccountId: '00' }));
    const b = mapAccount(acc({ subAccountId: '01' }));
    expect(a.ref).not.toBe(b.ref);
    expect(mapAccount(acc({ subAccountId: '00' })).ref).toBe(a.ref);
    expect(a.ref).toBe('1234567:00:12030000');
  });
  it('maps kinds', () => {
    const kind = (accountType: FinTSAccount['accountType']) =>
      mapAccount(acc({ accountType })).kind;
    expect(kind('CheckingAccount')).toBe('checking');
    expect(kind('SavingsAccount')).toBe('savings');
    expect(kind('FixedDepositAccount')).toBe('savings');
    expect(kind('CreditCardAccount')).toBe('credit_card');
    expect(kind('SecuritiesAccount')).toBe('depot');
    expect(kind('LoanMortgageAccount')).toBe('other');
  });
});

describe('classifyTanMethod', () => {
  it('classifies', () => {
    expect(classifyTanMethod({ name: 'DKB App', decoupled: true })).toBe('decoupled');
    expect(classifyTanMethod({ name: 'chipTAN optisch', decoupled: false })).toBe(
      'chiptan-optical',
    );
    expect(classifyTanMethod({ name: 'photoTAN', decoupled: false })).toBe('photo');
    expect(classifyTanMethod({ name: 'smsTAN', decoupled: false })).toBe('code');
  });
});

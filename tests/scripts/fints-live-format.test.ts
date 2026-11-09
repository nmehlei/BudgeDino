import { describe, expect, it } from 'vitest';
import { money } from '@budgedino/shared';
import type { ProviderAccount, ProviderTransaction } from '@budgedino/server/connectors/types';
import {
  formatAccounts,
  formatChallenge,
  formatTanMedia,
  formatTransactionSummary,
} from '../../scripts/fints-live-format';

const accounts: ProviderAccount[] = [
  {
    ref: 'REF-SECRET',
    name: 'Max Mustermann Girokonto',
    iban: 'DE89370400440532013000',
    kind: 'checking',
    currency: 'EUR',
  },
  {
    ref: 'REF-2',
    name: 'Spar Konto Erika',
    iban: 'DE02120300000000202051',
    kind: 'savings',
    currency: 'EUR',
  },
];

const txs: ProviderTransaction[] = [
  {
    providerId: 'PID-1',
    status: 'booked',
    bookingDate: '2026-11-03',
    amount: money(-123456, 'EUR'),
    counterparty: 'Erika Musterfrau',
    counterpartyIban: 'DE02120300000000202051',
    purpose: 'Miete November',
  },
  {
    providerId: 'PID-2',
    status: 'booked',
    bookingDate: '2026-10-01',
    amount: money(987654, 'EUR'),
    counterparty: 'Arbeitgeber GmbH',
  },
];

const FORBIDDEN = [
  '123456',
  '987654',
  '1234.56',
  'Erika',
  'Musterfrau',
  'Mustermann',
  'Arbeitgeber',
  'Miete',
  'DE89',
  'DE02',
  'REF-SECRET',
  'PID-1',
];

describe('live script output formatting', () => {
  it('prints only counts, kinds and booking dates', () => {
    const out = [
      formatAccounts(accounts),
      formatTransactionSummary(txs),
      formatChallenge({
        kind: 'image',
        message: 'Scan the photo',
        imageBase64: 'QUJD',
        mimeType: 'image/png',
      }),
    ].join('\n');
    expect(out).toContain('accounts: 2 [checking, savings]');
    expect(out).toContain('transactions: 2, booking dates 2026-10-01 .. 2026-11-03');
    expect(out).toContain('kind=image');
    expect(out).not.toContain('QUJD');
    for (const f of FORBIDDEN) expect(out).not.toContain(f);
  });

  it('handles an empty transaction list and a decoupled challenge', () => {
    expect(formatTransactionSummary([])).toBe('transactions: 0');
    expect(
      formatChallenge({ kind: 'decoupled', message: 'Approve in the app', pollAfterMs: 3000 }),
    ).toBe('challenge: kind=decoupled message="Approve in the app"');
  });
});

describe('TAN medium line', () => {
  const state = (requirement: number, media: string[]) => ({
    tanMethodId: 940,
    bankingInformation: {
      bpd: {
        supportedTanMethods: [
          { id: 920, tanMediaRequirement: 0, activeTanMedia: [] },
          { id: 940, tanMediaRequirement: requirement, activeTanMedia: media },
        ],
      },
    },
  });

  it('reports the requirement and the count of active media, never their names', () => {
    const out = formatTanMedia(state(2, ['Max Handy', 'Erika Handy']));
    expect(out).toBe('tan medium: required, active media 2');
    expect(out).not.toContain('Handy');
    expect(formatTanMedia(state(1, ['A']))).toBe('tan medium: optional, active media 1');
    expect(formatTanMedia(state(0, []))).toBe('tan medium: no, active media 0');
  });

  it('is unknown without usable banking information', () => {
    expect(formatTanMedia({ tanMethodId: 1, bankingInformation: null })).toBe(
      'tan medium: unknown',
    );
    expect(formatTanMedia({ tanMethodId: 1, bankingInformation: { bpd: {} } })).toBe(
      'tan medium: unknown',
    );
  });
});

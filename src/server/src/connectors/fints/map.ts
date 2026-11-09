import { Temporal } from 'temporal-polyfill';
import { currencyExponent, money } from '@budgedino/shared';
import type { AccountKind, ProviderAccount, ProviderTransaction } from '../types.js';
import type { FinTSAccount, FinTSTanKind, FinTSTanMethod, FinTSTx } from './port.js';

const IBAN_RE = /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/;

/** Float (lib-fints) to exact minor units, via the decimal string at the currency exponent. */
export function toMinor(amount: number, currency: string): bigint {
  if (!Number.isFinite(amount)) throw new RangeError(`Invalid amount: ${amount}`);
  const exponent = currencyExponent(currency);
  const fixed = amount.toFixed(exponent);
  const negative = fixed.startsWith('-');
  const digits = fixed.replace('-', '').replace('.', '');
  const minor = BigInt(digits);
  return negative ? -minor : minor;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/**
 * Calendar date (YYYY-MM-DD) of a date produced by a lib-fints parser. Parsers differ:
 * - MT940, HKKKU/DKKKU credit card: host-local midnight (`new Date(y, m, d)`);
 * - CAMT date-only values: host-local noon (`new Date('YYYY-MM-DDT12:00:00')`, `new Date(y,m,d,12)`);
 * - CAMT values with a time or UTC offset: a true instant, whose day is the bank's (Europe/Berlin).
 * Local getters are right for the first two (host-independent); the instant form is told apart by
 * not being local midnight or noon and is read in the bank's time zone.
 */
export function toIsoDate(d: Date): string {
  const localTod =
    d.getHours() * 3_600_000 +
    d.getMinutes() * 60_000 +
    d.getSeconds() * 1000 +
    d.getMilliseconds();
  if (localTod === 0 || localTod === 12 * 3_600_000) {
    return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  return Temporal.Instant.fromEpochMilliseconds(d.getTime())
    .toZonedDateTimeISO('Europe/Berlin')
    .toPlainDate()
    .toString();
}

export function mapTx(tx: FinTSTx, currency: string): ProviderTransaction {
  const out: ProviderTransaction = {
    providerId: null,
    status: 'booked',
    bookingDate: toIsoDate(tx.entryDate),
    valueDate: toIsoDate(tx.valueDate),
    amount: money(toMinor(tx.amount, currency), currency),
  };
  if (tx.remoteName) out.counterparty = tx.remoteName;
  const remote = tx.remoteAccountNumber?.replace(/\s+/g, '').toUpperCase();
  if (remote && IBAN_RE.test(remote)) out.counterpartyIban = remote;
  if (tx.purpose) out.purpose = tx.purpose;
  return out;
}

const KINDS: Partial<Record<FinTSAccount['accountType'], AccountKind>> = {
  CheckingAccount: 'checking',
  SavingsAccount: 'savings',
  FixedDepositAccount: 'savings',
  CreditCardAccount: 'credit_card',
  SecuritiesAccount: 'depot',
};

/** Stable, unique ref: the IBAN, else `number:subAccount:blz` (depot and settlement share numbers). */
export function accountRef(acc: FinTSAccount): string {
  return acc.iban ?? `${acc.accountNumber}:${acc.subAccountId ?? ''}:${acc.blz}`;
}

export function mapAccount(acc: FinTSAccount): ProviderAccount {
  const out: ProviderAccount = {
    ref: accountRef(acc),
    name: acc.product ?? acc.holder1 ?? acc.accountNumber,
    kind: KINDS[acc.accountType] ?? 'other',
    currency: acc.currency ?? 'EUR',
  };
  if (acc.iban) out.iban = acc.iban;
  return out;
}

export function classifyTanMethod(m: Pick<FinTSTanMethod, 'name' | 'decoupled'>): FinTSTanKind {
  if (m.decoupled) return 'decoupled';
  if (/photo|qr|bild/i.test(m.name)) return 'photo';
  if (/chip|flicker|optisch|optical/i.test(m.name)) return 'chiptan-optical';
  return 'code';
}

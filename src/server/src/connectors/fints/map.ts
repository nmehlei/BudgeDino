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

/** lib-fints builds dates with local-time constructors, so read them with local getters. */
export function toIsoDate(d: Date): string {
  const y = String(d.getFullYear()).padStart(4, '0');
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
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

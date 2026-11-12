import { currencyExponent } from '@budgedino/shared';

export type MoneyInputResult = { ok: true; minor: bigint } | { ok: false; error: string };

/** The API accepts at most 15 digits of minor units. */
const MAX_DIGITS = 15;

/**
 * Parses a German-style amount (`.` thousands separator, `,` decimal separator) into integer minor units.
 * Only strictly positive amounts with at most as many decimals as the currency has are accepted. String and
 * bigint arithmetic only: no floating point at any step.
 */
export function parseMoneyInput(text: string, currency: string): MoneyInputResult {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: false, error: 'Enter an amount' };

  const match = /^(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d+))?$/.exec(trimmed);
  if (!match) return { ok: false, error: 'Enter a positive amount like 1.234,56' };

  const exponent = currencyExponent(currency);
  const whole = (match[1] ?? '').replaceAll('.', '');
  const fraction = match[2] ?? '';
  if (fraction.length > exponent) {
    return {
      ok: false,
      error:
        exponent === 0 ? 'This currency has no decimals' : `Use at most ${exponent} decimal places`,
    };
  }
  const digits = `${whole}${fraction.padEnd(exponent, '0')}`.replace(/^0+(?=\d)/, '');
  if (digits.length > MAX_DIGITS) return { ok: false, error: 'This amount is too large' };
  const minor = BigInt(digits);
  if (minor <= 0n) return { ok: false, error: 'The amount must be greater than zero' };
  return { ok: true, minor };
}

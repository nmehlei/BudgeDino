import { currencyExponent } from '@budgedino/shared';

export interface MoneyJson {
  /** Integer minor units as a (possibly negative) decimal string, or a bigint. */
  minor: string | bigint;
  currency: string;
}

const formatters = new Map<string, Intl.NumberFormat>();

function formatterFor(currency: string, exponent: number): Intl.NumberFormat {
  const key = `${currency}:${exponent}`;
  let nf = formatters.get(key);
  if (!nf) {
    nf = new Intl.NumberFormat('de-DE', {
      style: 'currency',
      currency,
      minimumFractionDigits: exponent,
      maximumFractionDigits: exponent,
    });
    formatters.set(key, nf);
  }
  return nf;
}

/** Splits integer minor units into a decimal string using string arithmetic only (no floats). */
export function minorToDecimalString(minor: string | bigint, exponent: number): string {
  let value: bigint;
  try {
    value = BigInt(minor);
  } catch {
    value = 0n;
  }
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(exponent + 1, '0');
  const intPart = digits.slice(0, digits.length - exponent);
  const frac = exponent > 0 ? `.${digits.slice(digits.length - exponent)}` : '';
  return `${negative ? '-' : ''}${intPart}${frac}`;
}

/** `-123456789 EUR` becomes `-1.234.567,89 €`. Exact for any size: no float division. */
export function formatMoney(money: MoneyJson): string {
  const exponent = currencyExponent(money.currency);
  const decimal = minorToDecimalString(money.minor, exponent);
  try {
    // Intl.NumberFormat v3 formats decimal strings exactly; older engines coerce to a Number.
    return formatterFor(money.currency, exponent).format(decimal as unknown as number);
  } catch {
    // Unknown currency code: still show the amount rather than crash.
    return `${decimal.replace('.', ',')} ${money.currency}`;
  }
}

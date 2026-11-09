/** Money: integer minor units (bigint) plus an ISO 4217 currency code. Never floating point. */

/** ISO 4217 currency code: three uppercase letters. */
export type CurrencyCode = string;

export interface Money {
  readonly minor: bigint;
  readonly currency: CurrencyCode;
}

export class CurrencyMismatchError extends Error {
  constructor(
    readonly expected: CurrencyCode,
    readonly actual: CurrencyCode,
  ) {
    super(`Currency mismatch: expected ${expected}, got ${actual}`);
    this.name = 'CurrencyMismatchError';
  }
}

const CURRENCY_RE = /^[A-Z]{3}$/;

function assertCurrency(currency: CurrencyCode): void {
  if (!CURRENCY_RE.test(currency)) {
    throw new RangeError(`Invalid ISO 4217 currency code: ${currency}`);
  }
}

export function money(minor: bigint | number, currency: CurrencyCode): Money {
  assertCurrency(currency);
  if (typeof minor === 'number') {
    if (!Number.isSafeInteger(minor)) {
      throw new RangeError(`Money minor units must be a safe integer, got ${minor}`);
    }
    return { minor: BigInt(minor), currency };
  }
  return { minor, currency };
}

export function add(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
  return { minor: a.minor + b.minor, currency: a.currency };
}

export function sum(items: readonly Money[], currency: CurrencyCode): Money {
  return items.reduce(add, money(0n, currency));
}

export function negate(m: Money): Money {
  return { minor: -m.minor, currency: m.currency };
}

export function isNegative(m: Money): boolean {
  return m.minor < 0n;
}

/** Wire format: bigint travels as a decimal string. */
export interface MoneyJSON {
  minor: string;
  currency: string;
}

export function toJSON(m: Money): MoneyJSON {
  return { minor: m.minor.toString(), currency: m.currency };
}

export function fromJSON(json: MoneyJSON): Money {
  if (!/^-?\d+$/.test(json.minor)) {
    throw new RangeError(`Invalid money minor units: ${json.minor}`);
  }
  return money(BigInt(json.minor), json.currency);
}

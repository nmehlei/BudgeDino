import { asc, eq, sql } from 'drizzle-orm';
import { currencyExponent, money, type CurrencyCode, type Money } from '@budgedino/shared';
import type { Db } from '../db/client.js';
import { fxRates } from '../db/schema.js';
import type { FxSource } from './ecb.js';

/** No ECB rate for the currency on or before the requested date. */
export class FxRateMissingError extends Error {
  constructor(
    readonly currency: CurrencyCode,
    readonly on: string,
  ) {
    super(`No FX rate for ${currency} on or before ${on}`);
    this.name = 'FxRateMissingError';
  }
}

const exponentOf = (currency: CurrencyCode) => currencyExponent(currency);

const pow10 = (n: number) => 10n ** BigInt(n);

/** Splits a decimal string ("1.0800") into an exact integer numerator and power-of-ten scale. */
function decimalParts(rate: string): { n: bigint; scale: number } {
  if (!/^\d+(\.\d+)?$/.test(rate)) throw new RangeError(`Invalid FX rate: ${rate}`);
  const [whole = '0', frac = ''] = rate.split('.');
  const n = BigInt(whole + frac);
  if (n === 0n) throw new RangeError('FX rate must be positive');
  return { n, scale: frac.length };
}

/** `num / den` rounded half-to-even (banker's rounding); `den` must be positive. */
function divHalfEven(num: bigint, den: bigint): bigint {
  const negative = num < 0n;
  const abs = negative ? -num : num;
  let q = abs / den;
  const twiceRem = (abs % den) * 2n;
  if (twiceRem > den || (twiceRem === den && q % 2n === 1n)) q += 1n;
  return negative ? -q : q;
}

/**
 * Converts minor units between currencies using ECB-style rates (units of currency per 1 EUR), exactly:
 * the rates stay decimal strings turned into integer fractions, so there is no floating point and a single
 * half-even rounding at the end. `EUR` has rate "1".
 */
export function convertMinor(
  minor: bigint,
  from: CurrencyCode,
  to: CurrencyCode,
  fromRatePerEur: string,
  toRatePerEur: string,
): bigint {
  if (from === to) return minor;
  const f = decimalParts(fromRatePerEur);
  const t = decimalParts(toRatePerEur);
  // to_major = from_major * rateTo / rateFrom; scale both sides to minor units.
  const num = minor * pow10(exponentOf(to)) * t.n * pow10(f.scale);
  const den = pow10(exponentOf(from)) * f.n * pow10(t.scale);
  return divHalfEven(num, den);
}

export interface FxConverter {
  /** Converts `m` to `to` at the ECB rate of `on` (YYYY-MM-DD) or the latest earlier one; throws {@link FxRateMissingError}. */
  convert(m: Money, on: string, to: CurrencyCode): Promise<Money>;
}

interface DatedRate {
  date: string;
  rate: string;
}

/**
 * A converter with a per-instance rate cache (one query per currency); create one per computation, not per
 * process, so a refresh is picked up by the next request.
 */
export function createFxConverter(db: Db): FxConverter {
  const cache = new Map<string, Promise<DatedRate[]>>();
  const load = (currency: CurrencyCode) => {
    let hit = cache.get(currency);
    if (!hit) {
      hit = db
        .select({ date: fxRates.date, rate: fxRates.ratePerEur })
        .from(fxRates)
        .where(eq(fxRates.currency, currency))
        .orderBy(asc(fxRates.date));
      cache.set(currency, hit);
    }
    return hit;
  };
  async function rateOn(currency: CurrencyCode, on: string): Promise<string> {
    if (currency === 'EUR') return '1';
    const rows = await load(currency);
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i];
      if (row && row.date <= on) return row.rate;
    }
    throw new FxRateMissingError(currency, on);
  }
  return {
    async convert(m, on, to) {
      if (m.currency === to) return m;
      const [fromRate, toRate] = [await rateOn(m.currency, on), await rateOn(to, on)];
      return money(convertMinor(m.minor, m.currency, to, fromRate, toRate), to);
    },
  };
}

/** Upserts every rate of the source (`fx.refresh` job); idempotent. Returns the number of rates written. */
export async function refreshFxRates(db: Db, source: FxSource): Promise<number> {
  const rates = await source.fetchRates();
  const CHUNK = 500;
  for (let i = 0; i < rates.length; i += CHUNK) {
    await db
      .insert(fxRates)
      .values(rates.slice(i, i + CHUNK))
      .onConflictDoUpdate({
        target: [fxRates.date, fxRates.currency],
        set: { ratePerEur: sql`excluded.rate_per_eur` },
      });
  }
  return rates.length;
}

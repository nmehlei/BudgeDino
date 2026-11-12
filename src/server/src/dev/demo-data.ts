import type { FakeTx } from '../connectors/fake/fake-connector.js';

/** Number of days of history the demo data covers (today included). */
export const DEMO_DAYS = 60;

/** Deterministic PRNG (mulberry32): the same seed always yields the same sequence. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY_MS = 86_400_000;
const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

interface Merchant {
  counterparty: string;
  purpose: string;
  mcc?: string;
}

const REWE: Merchant = { counterparty: 'REWE Markt', purpose: 'REWE SAGT DANKE', mcc: '5411' };
const EDEKA: Merchant = { counterparty: 'EDEKA Center', purpose: 'EDEKA Einkauf', mcc: '5411' };
const LIEFERANDO: Merchant = { counterparty: 'Lieferando', purpose: 'Lieferando Bestellung' };
const EATING_OUT: Merchant[] = [
  LIEFERANDO,
  { counterparty: "McDonald's", purpose: "McDonald's Restaurant", mcc: '5814' },
];
const RAIL: Merchant = { counterparty: 'DB Vertrieb GmbH', purpose: 'DB Vertrieb Fahrkarte' };
const STREAMING: Merchant = { counterparty: 'Netflix International B.V.', purpose: 'NETFLIX' };
const EMPLOYER: Merchant = { counterparty: 'Acme GmbH', purpose: 'Gehalt' };

const between = (rand: () => number, min: number, max: number): number =>
  min + Math.floor(rand() * (max - min + 1));

/**
 * Realistic German household transactions for the `days` days ending on `today` (an ISO date):
 * groceries (REWE, EDEKA), eating out, rail tickets (DB), a monthly Netflix charge on the 15th and a
 * salary on the 1st. Pure and deterministic: the same `today` and `seed` give the same list. Amounts
 * are integer minor units (decimal strings, as `FakeTx` carries them), outflows negative.
 * Recent days always have activity so the current month and week show numbers.
 */
export function generateDemoTransactions(input: {
  today: string;
  seed?: number;
  days?: number;
}): FakeTx[] {
  const { today, seed = 42, days = DEMO_DAYS } = input;
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(todayMs)) throw new Error('today must be an ISO date (YYYY-MM-DD)');
  const rand = prng(seed);
  const out: FakeTx[] = [];
  let n = 0;
  const add = (bookingDate: string, minor: number, m: Merchant): void => {
    n += 1;
    out.push({
      providerId: `demo-${bookingDate.replaceAll('-', '')}-${n}`,
      status: 'booked',
      bookingDate,
      amountMinor: String(minor),
      currency: 'EUR',
      counterparty: m.counterparty,
      purpose: m.purpose,
      ...(m.mcc === undefined ? {} : { mcc: m.mcc }),
    });
  };

  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = isoDate(todayMs - offset * DAY_MS);
    const dayOfMonth = Number(date.slice(8, 10));
    if (dayOfMonth === 1) add(date, 285_000, EMPLOYER);
    if (dayOfMonth === 15) add(date, -1_299, STREAMING);
    if (rand() < 0.3 || offset === 0) add(date, -between(rand, 800, 6_500), REWE);
    if (rand() < 0.2 || offset === 3) add(date, -between(rand, 900, 5_500), EDEKA);
    if (rand() < 0.22 || offset <= 1) {
      const place = EATING_OUT[Math.floor(rand() * EATING_OUT.length)] ?? LIEFERANDO;
      add(date, -between(rand, 1_200, 3_800), place);
    }
    if (rand() < 0.08) add(date, -between(rand, 2_490, 8_990), RAIL);
  }
  return out;
}

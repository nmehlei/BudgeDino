/** A reference rate: how many units of `currency` one euro buys on `date`. Always a decimal string. */
export interface FxRate {
  date: string;
  currency: string;
  ratePerEur: string;
}

/** Where rates come from; production uses {@link EcbFxSource}, tests inject a fixture. */
export interface FxSource {
  fetchRates(): Promise<FxRate[]>;
}

export const ECB_HIST_90D_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml';

const DAY_CUBE_RE = /<Cube\s+time\s*=\s*(?:'([^']*)'|"([^"]*)")\s*>([\s\S]*?)<\/Cube>/g;
const RATE_CUBE_RE =
  /<Cube\s+currency\s*=\s*(?:'([^']*)'|"([^"]*)")\s+rate\s*=\s*(?:'([^']*)'|"([^"]*)")\s*\/>/g;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const RATE_RE = /^\d+(\.\d+)?$/;

function validDate(date: string): boolean {
  if (!DATE_RE.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

/**
 * Parses the ECB `eurofxref` XML with strict patterns (the document has a fixed, flat shape, so no XML
 * parser dependency is needed). Rates stay decimal strings; anything unexpected throws instead of being
 * skipped or guessed.
 */
export function parseEcbXml(xml: string): FxRate[] {
  const rates: FxRate[] = [];
  let days = 0;
  for (const day of xml.matchAll(DAY_CUBE_RE)) {
    const date = day[1] ?? day[2] ?? '';
    if (!validDate(date)) throw new Error('ECB rates: invalid date');
    days += 1;
    for (const cube of (day[3] ?? '').matchAll(RATE_CUBE_RE)) {
      const currency = cube[1] ?? cube[2] ?? '';
      const rate = cube[3] ?? cube[4] ?? '';
      if (!CURRENCY_RE.test(currency)) throw new Error('ECB rates: invalid currency code');
      if (!RATE_RE.test(rate) || Number(rate) <= 0) throw new Error('ECB rates: invalid rate');
      rates.push({ date, currency, ratePerEur: rate });
    }
  }
  if (days === 0 || rates.length === 0) throw new Error('ECB rates: no rates found in document');
  return rates;
}

type FetchLike = (url: string) => Promise<Response>;

/** Production source: the ECB's 90-day history, fetched over HTTPS. */
export class EcbFxSource implements FxSource {
  constructor(
    private readonly fetchFn: FetchLike = (url) =>
      fetch(url, { signal: AbortSignal.timeout(30_000) }),
  ) {}

  async fetchRates(): Promise<FxRate[]> {
    const res = await this.fetchFn(ECB_HIST_90D_URL);
    if (!res.ok) throw new Error(`ECB rates: HTTP ${res.status}`);
    return parseEcbXml(await res.text());
  }
}

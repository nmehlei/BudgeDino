import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EcbFxSource, parseEcbXml, type FxSource } from '@budgedino/server/fx/ecb';
import { convertMinor } from '@budgedino/server/fx/service';

const fixture = readFileSync(
  fileURLToPath(new URL('../../fixtures/ecb-hist-90d.xml', import.meta.url)),
  'utf8',
);

describe('parseEcbXml', () => {
  it('parses the 90-day fixture into decimal-string rates', () => {
    const rates = parseEcbXml(fixture);
    const dates = [...new Set(rates.map((r) => r.date))].sort();
    expect(dates).toHaveLength(64); // ECB publishes on business days only
    expect(dates[0]).toBe('2026-08-12');
    expect(dates[dates.length - 1]).toBe('2026-11-09');
    const spanDays =
      (Date.parse(`${dates[dates.length - 1]}T00:00:00Z`) - Date.parse(`${dates[0]}T00:00:00Z`)) /
      86_400_000;
    expect(spanDays).toBe(89);
    expect(rates).toContainEqual({ date: '2026-11-09', currency: 'USD', ratePerEur: '1.0800' });
    expect(rates.every((r) => /^\d+(\.\d+)?$/.test(r.ratePerEur))).toBe(true);
    expect(rates).toHaveLength(64 * 5);
  });

  it('accepts double-quoted attributes too', () => {
    const xml = `<Cube><Cube time="2026-11-09"><Cube currency="USD" rate="1.08"/></Cube></Cube>`;
    expect(parseEcbXml(xml)).toEqual([{ date: '2026-11-09', currency: 'USD', ratePerEur: '1.08' }]);
  });

  it('rejects malformed documents instead of guessing', () => {
    expect(() => parseEcbXml('<html>nope</html>')).toThrow(/ECB/);
    expect(() =>
      parseEcbXml(`<Cube><Cube time='2026-11-09'><Cube currency='USD' rate='abc'/></Cube></Cube>`),
    ).toThrow(/rate/);
    expect(() =>
      parseEcbXml(`<Cube><Cube time='2026-11-09'><Cube currency='USD' rate='0'/></Cube></Cube>`),
    ).toThrow(/rate/);
    expect(() =>
      parseEcbXml(`<Cube><Cube time='2026-13-45'><Cube currency='USD' rate='1.1'/></Cube></Cube>`),
    ).toThrow(/date/);
  });
});

describe('EcbFxSource', () => {
  it('fetches the 90-day URL and parses it', async () => {
    const urls: string[] = [];
    const source: FxSource = new EcbFxSource(async (url) => {
      urls.push(String(url));
      return new Response(fixture, { status: 200 });
    });
    const rates = await source.fetchRates();
    expect(urls).toEqual(['https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml']);
    expect(rates.length).toBe(320);
  });

  it('fails on a non-2xx response', async () => {
    const source = new EcbFxSource(async () => new Response('x', { status: 503 }));
    await expect(source.fetchRates()).rejects.toThrow(/503/);
  });
});

describe('convertMinor (exact rational, half-even)', () => {
  it('converts USD 10.00 at 1.0800 per EUR to EUR 9.26', () => {
    expect(convertMinor(1000n, 'USD', 'EUR', '1.0800', '1')).toBe(926n);
  });

  it('rounds half to even, both signs', () => {
    expect(convertMinor(1n, 'USD', 'EUR', '2', '1')).toBe(0n); // 0.5 -> 0
    expect(convertMinor(3n, 'USD', 'EUR', '2', '1')).toBe(2n); // 1.5 -> 2
    expect(convertMinor(5n, 'USD', 'EUR', '2', '1')).toBe(2n); // 2.5 -> 2
    expect(convertMinor(-3n, 'USD', 'EUR', '2', '1')).toBe(-2n);
    expect(convertMinor(-5n, 'USD', 'EUR', '2', '1')).toBe(-2n);
  });

  it('is the identity for equal currencies', () => {
    expect(convertMinor(12_345n, 'EUR', 'EUR', '1', '1')).toBe(12_345n);
  });

  it('handles currencies with other minor-unit exponents (JPY has none)', () => {
    expect(convertMinor(1000n, 'EUR', 'JPY', '1', '163.31')).toBe(1633n); // 1633.1
    expect(convertMinor(1633n, 'JPY', 'EUR', '163.31', '1')).toBe(1000n);
  });

  it('computes cross rates (USD -> GBP)', () => {
    // 10.00 USD / 1.08 * 0.865 = 8.0092 GBP
    expect(convertMinor(1000n, 'USD', 'GBP', '1.0800', '0.8650')).toBe(801n);
  });
});

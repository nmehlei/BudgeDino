import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { periodFor, previousPeriod } from '@budgedino/shared';

const TZ = 'Europe/Berlin';
const d = (s: string) => new Date(s);

describe('periodFor', () => {
  it('weekly: Sunday 23:30 Berlin stays in W46', () => {
    const p = periodFor(d('2026-11-15T22:30:00Z'), 'weekly', TZ);
    expect(p.key).toBe('2026-W46');
    expect(p.start).toEqual(d('2026-11-09T00:00:00+01:00'));
    expect(p.end).toEqual(d('2026-11-16T00:00:00+01:00'));
  });

  it('weekly: Monday 00:30 Berlin is W47', () => {
    expect(periodFor(d('2026-11-15T23:30:00Z'), 'weekly', TZ).key).toBe('2026-W47');
  });

  it('weekly: DST week is 167 h', () => {
    const p = periodFor(d('2026-03-29T12:00:00Z'), 'weekly', TZ);
    expect((p.end.getTime() - p.start.getTime()) / 3_600_000).toBe(167);
  });

  it('monthly: New Year in Berlin is next month', () => {
    const p = periodFor(d('2026-12-31T23:30:00Z'), 'monthly', TZ);
    expect(p.key).toBe('2027-01');
    expect(p.start).toEqual(d('2027-01-01T00:00:00+01:00'));
    expect(p.end).toEqual(d('2027-02-01T00:00:00+01:00'));
  });

  it('weekly: ISO year edge W53', () => {
    expect(periodFor(d('2026-12-31T12:00:00Z'), 'weekly', TZ).key).toBe('2026-W53');
  });

  it('weekly: early January belongs to previous ISO year', () => {
    expect(periodFor(d('2027-01-01T12:00:00Z'), 'weekly', TZ).key).toBe('2026-W53');
  });

  it('rejects an invalid time zone', () => {
    expect(() => periodFor(d('2026-01-01T00:00:00Z'), 'monthly', 'Nope/Zone')).toThrow();
  });

  const instant = fc.date({
    min: d('1990-01-01T00:00:00Z'),
    max: d('2100-01-01T00:00:00Z'),
    noInvalidDate: true,
  });
  const kind = fc.constantFrom('weekly' as const, 'monthly' as const);
  const zone = fc.constantFrom(TZ, 'UTC', 'America/New_York', 'Pacific/Auckland');

  it('contains the instant and chains to the previous period', () => {
    fc.assert(
      fc.property(instant, kind, zone, (i, k, z) => {
        const p = periodFor(i, k, z);
        expect(p.start.getTime()).toBeLessThanOrEqual(i.getTime());
        expect(i.getTime()).toBeLessThan(p.end.getTime());
        const prev = previousPeriod(p, z);
        expect(prev.end.getTime()).toBe(p.start.getTime());
        expect(prev.kind).toBe(k);
        expect(periodFor(new Date(p.start.getTime() - 1), k, z).key).toBe(prev.key);
      }),
    );
  });
});

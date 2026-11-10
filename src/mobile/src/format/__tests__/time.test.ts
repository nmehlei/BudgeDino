import { formatPeriodLabel } from '../time';

describe('formatPeriodLabel', () => {
  it('monthly: Berlin midnight on the 1st (23:00Z the day before) is not off by one', () => {
    expect(
      formatPeriodLabel('monthly', '2026-10-31T23:00:00.000Z', '2026-11-30T23:00:00.000Z'),
    ).toBe('November 2026');
  });

  it('weekly within a month; the exclusive end shows the last included day', () => {
    expect(
      formatPeriodLabel('weekly', '2026-11-08T23:00:00.000Z', '2026-11-15T23:00:00.000Z'),
    ).toBe('9–15 Nov');
  });

  it('weekly across a month boundary, right after the DST switch', () => {
    expect(
      formatPeriodLabel('weekly', '2026-10-25T23:00:00.000Z', '2026-11-01T23:00:00.000Z'),
    ).toBe('26 Oct – 1 Nov');
  });

  it('weekly containing the DST switch (Sunday 25 Oct is 25 hours long)', () => {
    expect(
      formatPeriodLabel('weekly', '2026-10-18T22:00:00.000Z', '2026-10-25T23:00:00.000Z'),
    ).toBe('19–25 Oct');
  });

  it('weekly across months, as in the spec example', () => {
    expect(
      formatPeriodLabel('weekly', '2026-10-27T23:00:00.000Z', '2026-11-03T23:00:00.000Z'),
    ).toBe('28 Oct – 3 Nov');
  });

  it('respects an explicit time zone', () => {
    expect(
      formatPeriodLabel('weekly', '2026-11-09T00:00:00.000Z', '2026-11-16T00:00:00.000Z', 'UTC'),
    ).toBe('9–15 Nov');
  });

  it('falls back on garbage', () => {
    expect(formatPeriodLabel('monthly', 'x', 'y')).toBe('Month');
  });
});

import { comparisonAt, cumulative, linePath, niceMax } from '../geometry';

const d = (...minors: number[]) => minors.map((m) => ({ spent: { minor: String(m) } }));

describe('cumulative', () => {
  it('sums running totals', () => {
    expect(cumulative(d(100, 0, 250))).toEqual([100n, 100n, 350n]);
  });
  it('clamps a refund that would go below 0', () => {
    expect(cumulative(d(100, -500, 50))).toEqual([100n, 0n, 50n]);
  });
  it('is empty for no days', () => {
    expect(cumulative([])).toEqual([]);
  });
});

describe('niceMax', () => {
  it('rounds up to 1/2/5 x 10^k', () => {
    expect(niceMax(35138n)).toBe(50000n);
    expect(niceMax(50000n)).toBe(50000n);
    expect(niceMax(50001n)).toBe(100000n);
    expect(niceMax(120000n)).toBe(200000n);
    expect(niceMax(100n)).toBe(200n);
    expect(niceMax(201n)).toBe(1000n);
  });
  it('is at least 200 for zero, so the half is a whole unit', () => {
    expect(niceMax(0n)).toBe(200n);
  });
});

describe('linePath', () => {
  it('is empty for no values', () => {
    expect(linePath([], 30, 100n, 290, 100)).toBe('');
  });
  it('draws a horizontal segment for a single value', () => {
    expect(linePath([0n], 30, 100n, 290, 100)).toBe('M0,100L10,100');
  });
  it('matches a known 3-point case', () => {
    expect(linePath([0n, 50n, 100n], 3, 100n, 200, 100)).toBe('M0,100L100,50L200,0');
  });
  it('has no NaN on the 1st of the month or with a 1-day period', () => {
    expect(linePath([0n], 1, 100n, 200, 100)).not.toContain('NaN');
    expect(linePath([0n], 30, 0n, 200, 100)).not.toContain('NaN');
  });
});

describe('comparisonAt', () => {
  it('compares at the current day index', () => {
    const cur = cumulative(d(100, 100, 100));
    const prev = cumulative(d(50, 50, 50, 50, 50));
    expect(comparisonAt(cur, prev)).toEqual({ day: 3, current: 300n, previous: 150n });
  });
  it('clamps to the shorter previous period', () => {
    const cur = cumulative(d(10, 10, 10, 10, 10));
    const prev = cumulative(d(5, 5, 5));
    expect(comparisonAt(cur, prev)).toEqual({ day: 5, current: 50n, previous: 15n });
  });
  it('is null when previous sums to 0 or current is empty', () => {
    expect(comparisonAt([10n], [0n, 0n])).toBeNull();
    expect(comparisonAt([], [5n])).toBeNull();
    expect(comparisonAt([5n], [])).toBeNull();
  });
});

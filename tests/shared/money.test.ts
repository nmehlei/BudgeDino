import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CurrencyMismatchError,
  add,
  fromJSON,
  isNegative,
  money,
  negate,
  sum,
  toJSON,
} from '@budgedino/shared';

describe('money', () => {
  it('adds same-currency amounts', () => {
    expect(add(money(150, 'EUR'), money(-50, 'EUR'))).toEqual(money(100, 'EUR'));
  });

  it('rejects mixed currencies', () => {
    expect(() => add(money(1, 'EUR'), money(1, 'USD'))).toThrow(CurrencyMismatchError);
  });

  it('rejects non-integer numbers and invalid currency codes', () => {
    expect(() => money(1.5, 'EUR')).toThrow();
    expect(() => money(NaN, 'EUR')).toThrow();
    expect(() => money(1, 'eur')).toThrow();
    expect(() => money(1, 'EURO')).toThrow();
  });

  it('negates and detects negatives', () => {
    expect(negate(money(5, 'EUR'))).toEqual(money(-5, 'EUR'));
    expect(isNegative(money(-1, 'EUR'))).toBe(true);
    expect(isNegative(money(0, 'EUR'))).toBe(false);
  });

  it('sum of nothing is zero in the given currency', () => {
    expect(sum([], 'EUR')).toEqual(money(0, 'EUR'));
  });

  it('sum rejects items of another currency', () => {
    expect(() => sum([money(1, 'USD')], 'EUR')).toThrow(CurrencyMismatchError);
  });

  const amount = fc.bigInt({ min: -(2n ** 80n), max: 2n ** 80n }).map((n) => money(n, 'EUR'));

  it('sum is commutative and associative', () => {
    fc.assert(
      fc.property(fc.array(amount), fc.array(amount), (xs, ys) => {
        expect(sum([...xs, ...ys], 'EUR')).toEqual(sum([...ys, ...xs], 'EUR'));
        expect(sum([...xs, ...ys], 'EUR')).toEqual(add(sum(xs, 'EUR'), sum(ys, 'EUR')));
      }),
    );
  });

  it('JSON round-trips arbitrary bigint', () => {
    fc.assert(
      fc.property(fc.bigInt(), (n) => {
        const m = money(n, 'EUR');
        const wire = JSON.parse(JSON.stringify(toJSON(m))) as { minor: string; currency: string };
        expect(fromJSON(wire)).toEqual(m);
      }),
    );
  });

  it('fromJSON rejects malformed input', () => {
    expect(() => fromJSON({ minor: '1.5', currency: 'EUR' })).toThrow();
    expect(() => fromJSON({ minor: '', currency: 'EUR' })).toThrow();
  });
});

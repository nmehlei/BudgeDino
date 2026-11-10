import { formatMoney, minorToDecimalString } from '../money';

const nb = (s: string) => s.split(String.fromCharCode(160)).join(' ');

describe('formatMoney', () => {
  it('formats large negative euro amounts', () => {
    expect(nb(formatMoney({ minor: -123456789n, currency: 'EUR' }))).toBe('-1.234.567,89 €');
    expect(nb(formatMoney({ minor: '-123456789', currency: 'EUR' }))).toBe('-1.234.567,89 €');
  });

  it('formats zero-decimal currencies without a fraction', () => {
    expect(nb(formatMoney({ minor: 100n, currency: 'JPY' }))).toBe('100 ¥');
  });

  it('formats zero', () => {
    expect(nb(formatMoney({ minor: 0n, currency: 'EUR' }))).toBe('0,00 €');
  });

  it('pads sub-unit amounts and keeps the sign', () => {
    expect(nb(formatMoney({ minor: '5', currency: 'EUR' }))).toBe('0,05 €');
    expect(nb(formatMoney({ minor: '-5', currency: 'EUR' }))).toBe('-0,05 €');
  });

  it('formats foreign currencies', () => {
    expect(nb(formatMoney({ minor: '123456', currency: 'USD' }))).toBe('1.234,56 $');
  });

  it('does not crash on garbage', () => {
    expect(formatMoney({ minor: 'abc', currency: 'EUR' })).toContain('0,00');
    expect(formatMoney({ minor: '100', currency: 'XXXX' })).toContain('1,00');
  });
});

describe('minorToDecimalString', () => {
  it('is exact beyond the safe integer range', () => {
    expect(minorToDecimalString('900719925474099312345', 2)).toBe('9007199254740993123.45');
  });
});

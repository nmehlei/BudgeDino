import { parseMoneyInput } from '../money-input';

describe('parseMoneyInput', () => {
  it.each([
    ['1.234,56', 'EUR', 123456n],
    ['12,5', 'EUR', 1250n],
    ['500', 'EUR', 50000n],
    ['0,01', 'EUR', 1n],
    ['  42,00 ', 'EUR', 4200n],
    ['100', 'JPY', 100n],
    ['1.000.000', 'EUR', 100000000n],
  ])('parses %s %s', (text, currency, minor) => {
    expect(parseMoneyInput(text, currency)).toEqual({ ok: true, minor });
  });

  it.each([
    ['0', 'EUR'],
    ['0,00', 'EUR'],
    ['-5', 'EUR'],
    ['abc', 'EUR'],
    ['', 'EUR'],
    ['   ', 'EUR'],
    ['1,234', 'EUR'],
    ['12,', 'EUR'],
    ['1.23', 'EUR'],
    ['1,5,5', 'EUR'],
    ['1e3', 'EUR'],
    ['100,5', 'JPY'],
    ['9999999999999999', 'EUR'],
  ])('rejects %j (%s)', (text, currency) => {
    const result = parseMoneyInput(text, currency);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
  });
});

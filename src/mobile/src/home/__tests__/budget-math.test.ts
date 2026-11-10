import { barState, ratioToBps } from '../budget-math';

const b = (spent: string, amount: string, ratio: string) => ({
  spent: { minor: spent, currency: 'EUR' },
  amount: { minor: amount, currency: 'EUR' },
  ratio,
});

describe('ratioToBps', () => {
  it('parses four-decimal strings without floats', () => {
    expect(ratioToBps('1.2500')).toBe(12500);
    expect(ratioToBps('0.0001')).toBe(1);
    expect(ratioToBps('3')).toBe(30000);
    expect(ratioToBps('garbage')).toBe(0);
  });
});

describe('barState', () => {
  it('is ok below 0.8', () => {
    expect(barState(b('5000', '10000', '0.5000'))).toMatchObject({ fillPercent: 50, level: 'ok' });
  });

  it('is amber from 0.8 and red from 1', () => {
    expect(barState(b('8000', '10000', '0.8000')).level).toBe('warn');
    const full = barState(b('10000', '10000', '1.0000'));
    expect(full).toMatchObject({ fillPercent: 100, level: 'over', overBudget: false });
  });

  it('clamps a ratio above 1 at 100 % in red', () => {
    expect(barState(b('12500', '10000', '1.2500'))).toMatchObject({
      fillPercent: 100,
      level: 'over',
      overBudget: true,
      usedPercent: 125,
    });
  });

  it('clamps refunds (negative spent) at 0 %', () => {
    expect(barState(b('-2500', '10000', '0.0000'))).toMatchObject({ fillPercent: 0, level: 'ok' });
    // even if a server ever sent a nonsense ratio
    expect(barState(b('-2500', '10000', '0.5000')).fillPercent).toBe(0);
  });

  it('zero budget: no spending shows an empty bar, spending a full red bar, no division', () => {
    expect(barState(b('0', '0', '0.0000'))).toMatchObject({ fillPercent: 0, level: 'ok' });
    expect(barState(b('-100', '0', '0.0000'))).toMatchObject({ fillPercent: 0, overBudget: false });
    expect(barState(b('100', '0', '0.0000'))).toMatchObject({
      fillPercent: 100,
      level: 'over',
      overBudget: true,
    });
  });
});

import type { BudgetView } from '@budgedino/shared';

import { barState, elapsedFraction, groupForHome, ratioToBps } from '../budget-math';

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

describe('elapsedFraction', () => {
  const period = { start: '2026-11-01T00:00:00.000Z', end: '2026-11-11T00:00:00.000Z' };
  it('is 0 at the start, about half in the middle and 1 after the end', () => {
    expect(elapsedFraction(period, new Date('2026-11-01T00:00:00.000Z'))).toBe(0);
    expect(elapsedFraction(period, new Date('2026-11-06T00:00:00.000Z'))).toBeCloseTo(0.5, 5);
    expect(elapsedFraction(period, new Date('2026-12-01T00:00:00.000Z'))).toBe(1);
    expect(elapsedFraction(period, new Date('2026-10-01T00:00:00.000Z'))).toBe(0);
  });
  it('survives garbage', () => {
    expect(elapsedFraction({ start: 'x', end: 'y' }, new Date())).toBe(0);
  });
});

describe('groupForHome', () => {
  const eur = (minor: string) => ({ minor, currency: 'EUR' });
  const bv = (id: string, name: string, categoryIds: string[]): BudgetView => ({
    id,
    name,
    categoryIds,
    periodKind: 'monthly',
    amount: eur('10000'),
    spent: eur('0'),
    ratio: '0.0000',
    fxMissing: false,
    period: { key: '2026-11', start: '2026-11-01T00:00:00.000Z', end: '2026-12-01T00:00:00.000Z' },
  });
  const item = (categoryId: string | null, name: string, minor: string) => ({
    categoryId,
    name,
    spent: eur(minor),
    icon: null,
    color: null,
  });
  const names = new Map([['c3', 'Cinema']]);

  it('a single-category budget is one group with that category', () => {
    const g = groupForHome([bv('b1', 'Food', ['c1'])], [item('c1', 'Groceries', '500')]);
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({
      kind: 'budget',
      categories: [{ categoryId: 'c1', name: 'Groceries', spent: eur('500') }],
    });
  });

  it('a multi-category budget lists its categories; unspent ones have null spent and a mapped name', () => {
    const g = groupForHome([bv('b1', 'Fun', ['c1', 'c3'])], [item('c1', 'Games', '500')], names);
    expect(g[0]).toMatchObject({
      categories: [
        { categoryId: 'c1', spent: eur('500') },
        { categoryId: 'c3', name: 'Cinema', spent: null },
      ],
    });
  });

  it('covered categories are not in the rest; the rest is by spent descending, uncategorised included', () => {
    const g = groupForHome(
      [bv('b1', 'Food', ['c1'])],
      [
        item('c1', 'Groceries', '500'),
        item('c2', 'Rent', '90000'),
        item(null, 'Uncategorised', '700'),
        item('c4', 'Fees', '100'),
      ],
    );
    expect(g.map((x) => (x.kind === 'budget' ? x.budget.id : x.categoryId))).toEqual([
      'b1',
      'c2',
      null,
      'c4',
    ]);
  });

  it('budgets are in name order and a category in two budgets appears under both', () => {
    const g = groupForHome(
      [bv('b2', 'Zeta', ['c1']), bv('b1', 'Alpha', ['c1', 'c2'])],
      [item('c1', 'Groceries', '500')],
    );
    expect(g.map((x) => (x.kind === 'budget' ? x.budget.name : '?'))).toEqual(['Alpha', 'Zeta']);
    expect(g[0]).toMatchObject({ categories: [{ categoryId: 'c1' }, { categoryId: 'c2' }] });
    expect(g[1]).toMatchObject({ categories: [{ categoryId: 'c1' }] });
  });
});

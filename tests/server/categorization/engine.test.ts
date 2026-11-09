import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  buildHeuristics,
  categorize,
  type CategorizeContext,
  type DecryptedTx,
  type Rule,
} from '@budgedino/server/categorization/engine';
import { DEFAULT_CATEGORIES } from '@budgedino/server/categorization/defaults';

const cats = DEFAULT_CATEGORIES.map((c) => ({
  id: `cat-${c.key}`,
  name: c.name,
  isIncome: c.isIncome ?? false,
}));
const heuristics = buildHeuristics(cats);

const tx = (over: Partial<DecryptedTx> = {}): DecryptedTx => ({
  accountId: 'acc-1',
  amountMinor: -1234n,
  currency: 'EUR',
  counterparty: null,
  counterpartyIban: null,
  counterpartyBidx: null,
  purpose: null,
  mcc: null,
  ...over,
});

const ctx = (over: Partial<CategorizeContext> = {}): CategorizeContext => ({
  rules: [],
  learned: new Map(),
  heuristics,
  ...over,
});

const rule = (over: Partial<Rule> & Pick<Rule, 'match' | 'categoryId'>): Rule => ({
  id: 'r1',
  priority: 1,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  ...over,
});

describe('categorize', () => {
  it('prefers rules over learned over heuristics', () => {
    const t = tx({ counterparty: 'REWE Markt', counterpartyBidx: 'b1' });
    const learned = new Map([['b1', 'cat-shopping']]);
    expect(categorize(t, ctx())).toEqual({ categoryId: 'cat-groceries', source: 'heuristic' });
    expect(categorize(t, ctx({ learned }))).toEqual({
      categoryId: 'cat-shopping',
      source: 'learned',
    });
    const rules = [rule({ match: { counterpartyContains: 'rewe' }, categoryId: 'cat-kids' })];
    expect(categorize(t, ctx({ learned, rules }))).toEqual({
      categoryId: 'cat-kids',
      source: 'rule',
    });
  });

  it('orders rules by priority, then newest', () => {
    const t = tx({ counterparty: 'Foo' });
    const match = { counterpartyContains: 'foo' };
    const low = rule({ id: 'a', priority: 1, match, categoryId: 'cat-fees' });
    const high = rule({ id: 'b', priority: 2, match, categoryId: 'cat-cash' });
    expect(categorize(t, ctx({ rules: [low, high] })).categoryId).toBe('cat-cash');
    const newer = rule({
      id: 'c',
      priority: 2,
      match,
      categoryId: 'cat-travel',
      createdAt: new Date('2026-06-01T00:00:00Z'),
    });
    expect(categorize(t, ctx({ rules: [low, high, newer] })).categoryId).toBe('cat-travel');
  });

  it('never overwrites a manual category', () => {
    const t = tx({
      counterparty: 'REWE',
      categoryId: 'cat-gifts-donations',
      categorySource: 'manual',
    });
    const rules = [rule({ match: { counterpartyContains: 'rewe' }, categoryId: 'cat-kids' })];
    expect(categorize(t, ctx({ rules }))).toEqual({
      categoryId: 'cat-gifts-donations',
      source: 'manual',
    });
  });

  it('maps MCC codes', () => {
    expect(categorize(tx({ mcc: '5411' }), ctx())).toEqual({
      categoryId: 'cat-groceries',
      source: 'heuristic',
    });
    expect(categorize(tx({ mcc: '5814' }), ctx()).categoryId).toBe('cat-eating-out');
    expect(categorize(tx({ mcc: '4900' }), ctx()).categoryId).toBe('cat-utilities');
    expect(categorize(tx({ mcc: '9999' }), ctx()).source).toBe('none');
  });

  it('matches merchant keywords case-insensitively on word boundaries, counterparty before purpose', () => {
    expect(categorize(tx({ counterparty: 'rewe markt gmbh' }), ctx()).categoryId).toBe(
      'cat-groceries',
    );
    expect(categorize(tx({ counterparty: 'DB VERTRIEB GMBH' }), ctx()).categoryId).toBe(
      'cat-transport',
    );
    expect(categorize(tx({ purpose: 'Abo NETFLIX.COM' }), ctx()).categoryId).toBe(
      'cat-subscriptions',
    );
    expect(categorize(tx({ counterparty: 'dm-drogerie markt' }), ctx()).categoryId).toBe(
      'cat-health',
    );
    // not on a word boundary
    expect(categorize(tx({ counterparty: 'PREWEIT GmbH' }), ctx()).source).toBe('none');
    expect(categorize(tx({ counterparty: 'ALDIMAT' }), ctx()).source).toBe('none');
    // counterparty wins over purpose
    expect(categorize(tx({ counterparty: 'LIDL', purpose: 'NETFLIX' }), ctx()).categoryId).toBe(
      'cat-groceries',
    );
  });

  it('treats a positive amount as Income only for salary-like purposes', () => {
    expect(categorize(tx({ amountMinor: 250000n, purpose: 'Gehalt Oktober' }), ctx())).toEqual({
      categoryId: 'cat-income',
      source: 'heuristic',
    });
    expect(categorize(tx({ amountMinor: 250000n, purpose: 'LOHN/GEHALT' }), ctx()).categoryId).toBe(
      'cat-income',
    );
    expect(categorize(tx({ amountMinor: 5000n, purpose: 'Danke fuers Essen' }), ctx()).source).toBe(
      'none',
    );
    expect(categorize(tx({ amountMinor: -5000n, purpose: 'Gehalt' }), ctx()).source).toBe('none');
  });

  it('treats salary credits as Income even from merchant-named employers', () => {
    const pos = (over: Partial<DecryptedTx>) => tx({ amountMinor: 300000n, ...over });
    expect(
      categorize(pos({ counterparty: 'DEUTSCHE BAHN AG', purpose: 'Gehalt 10/2026' }), ctx())
        .categoryId,
    ).toBe('cat-income');
    expect(categorize(pos({ counterparty: 'Lidl', purpose: 'GEHALT NETTO' }), ctx())).toEqual({
      categoryId: 'cat-income',
      source: 'heuristic',
    });
    expect(
      categorize(pos({ counterparty: 'REWE Markt GmbH', mcc: '5411', purpose: 'Lohn' }), ctx())
        .categoryId,
    ).toBe('cat-income');
    expect(categorize(pos({ counterparty: 'Salary Corp' }), ctx()).categoryId).toBe('cat-income');
    // negative REWE payment still Groceries
    expect(categorize(tx({ counterparty: 'REWE', purpose: 'Gehalt' }), ctx()).categoryId).toBe(
      'cat-groceries',
    );
  });

  it('matches rule fields case-insensitively and requires all of them', () => {
    const t = tx({
      counterparty: 'Stadtwerke Berlin',
      counterpartyIban: 'DE02 1203 0000 0000 2020 51',
      purpose: 'Abschlag',
      amountMinor: -8000n,
    });
    const m = (match: Rule['match']) =>
      categorize(t, ctx({ rules: [rule({ match, categoryId: 'cat-housing' })] })).source;
    expect(m({ counterpartyIban: 'de02120300000000202051' })).toBe('rule');
    expect(m({ counterpartyContains: 'STADTWERKE', purposeContains: 'abschlag' })).toBe('rule');
    expect(m({ counterpartyContains: 'stadtwerke', purposeContains: 'miete' })).toBe('none');
    expect(m({ amountMinMinor: '7000', amountMaxMinor: '9000' })).toBe('rule');
    expect(m({ amountMinMinor: '9000' })).toBe('none');
    expect(m({ accountId: 'other' })).toBe('none');
    expect(m({})).toBe('none');
  });

  it('is deterministic for a fixed context (property)', () => {
    const arbTx = fc.record({
      accountId: fc.constantFrom('acc-1', 'acc-2'),
      amountMinor: fc.bigInt({ min: -1_000_000n, max: 1_000_000n }),
      currency: fc.constant('EUR'),
      counterparty: fc.option(fc.constantFrom('REWE', 'Netflix', 'Foo GmbH', 'BVG'), {
        nil: null,
      }),
      counterpartyIban: fc.constant(null),
      counterpartyBidx: fc.option(fc.constantFrom('b1', 'b2'), { nil: null }),
      purpose: fc.option(fc.constantFrom('Gehalt', 'Miete', 'x'), { nil: null }),
      mcc: fc.option(fc.constantFrom('5411', '4900', '0000'), { nil: null }),
    });
    const rules = [
      rule({ id: 'a', match: { counterpartyContains: 'foo' }, categoryId: 'cat-fees' }),
      rule({ id: 'b', match: { purposeContains: 'miete' }, categoryId: 'cat-housing' }),
    ];
    const learned = new Map([['b2', 'cat-leisure']]);
    fc.assert(
      fc.property(arbTx, (t) => {
        const a = categorize(t, ctx({ rules, learned }));
        const b = categorize(t, ctx({ rules: [...rules].reverse(), learned }));
        expect(a).toEqual(b);
      }),
    );
  });
});

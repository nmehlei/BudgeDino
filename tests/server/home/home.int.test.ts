import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { categories, connectors } from '@budgedino/server/db/schema';
import { createWorld, type World } from '../../support/budget-world.js';
import { startTestDatabase, type TestDatabase } from '../../support/postgres.js';

interface Money {
  minor: string;
  currency: string;
}
interface HomeView {
  period: { kind: string; key: string; start: string; end: string };
  budgets: { name: string; period: { key: string }; spent: Money; ratio: string }[];
  breakdown: {
    categoryId: string | null;
    name: string;
    spent: Money;
    icon: string | null;
    color: string | null;
  }[];
  daily: { date: string; spent: Money }[];
  fxMissing: boolean;
  income: Money;
  uncategorizedIncome: Money;
  sync: Record<string, unknown>[];
}

let database: TestDatabase;
let w: World;

beforeAll(async () => {
  database = await startTestDatabase();
}, 120_000);
afterAll(async () => {
  await w?.app.close();
  await database.stop();
});
beforeEach(async () => {
  await w?.app.close();
  w = await createWorld(database);
});

const getHome = async (token: string, qs = '') => {
  const res = await w.call('GET', `/home${qs}`, token);
  return { status: res.status, home: res.json as HomeView, body: res.body };
};

async function budget(name: string, periodKind: 'weekly' | 'monthly', cats: string[]) {
  const res = await w.call('POST', '/budgets', w.aToken, {
    name,
    categoryIds: cats.map((c) => w.cat[c]),
    periodKind,
    amount: { minor: '50000', currency: 'EUR' },
  });
  expect(res.status, res.body).toBe(201);
}

describe('GET /home', () => {
  it('returns the month, budgets, breakdown sorted by spent and income', async () => {
    await budget('Groceries', 'monthly', ['Groceries']);
    await w.add(w.aAccount, -34_000n, '2026-11-02', 'Groceries');
    await w.add(w.aAccount, -5_000n, '2026-11-03', 'Shopping');
    await w.add(w.aAccount, -12_000n, '2026-11-03', 'Transport');
    await w.add(w.aAccount, 250_000n, '2026-11-01', 'Income');
    await w.add(w.aAccount, -50_000n, '2026-11-01', 'Transfer'); // transfer category excluded
    const { status, home } = await getHome(w.aToken);
    expect(status).toBe(200);
    expect(home.period).toMatchObject({ kind: 'monthly', key: '2026-11' });
    expect(home.period.start).toBe('2026-10-31T23:00:00.000Z');
    expect(home.period.end).toBe('2026-11-30T23:00:00.000Z');
    expect(home.budgets).toHaveLength(1);
    expect(home.budgets[0]).toMatchObject({ name: 'Groceries', ratio: '0.6800' });
    expect(home.breakdown.map((b) => [b.name, b.spent.minor])).toEqual([
      ['Groceries', '34000'],
      ['Transport', '12000'],
      ['Shopping', '5000'],
    ]);
    expect(home.income).toEqual({ minor: '250000', currency: 'EUR' });
  });

  it('supports current, previous and explicit period keys', async () => {
    await budget('Groceries', 'monthly', ['Groceries']);
    await w.add(w.aAccount, -10_000n, '2026-11-02', 'Groceries');
    await w.add(w.aAccount, -20_000n, '2026-10-20', 'Groceries');
    const prev = (await getHome(w.aToken, '?period=previous')).home;
    expect(prev.period.key).toBe('2026-10');
    expect(prev.budgets[0]?.spent.minor).toBe('20000');
    expect(prev.breakdown[0]?.spent.minor).toBe('20000');
    const key = (await getHome(w.aToken, '?period=2026-10')).home;
    expect(key.budgets[0]?.spent.minor).toBe('20000');
    const cur = (await getHome(w.aToken, '?period=current')).home;
    expect(cur.budgets[0]?.spent.minor).toBe('10000');
    const week = (await getHome(w.aToken, '?period=2026-W46')).home;
    expect(week.period).toMatchObject({ kind: 'weekly', key: '2026-W46' });
    expect(week.breakdown).toEqual([]); // Nov 2 lies in week 45
    // a monthly budget under a weekly request: the month containing the week's start
    expect(week.budgets[0]?.period.key).toBe('2026-11');
    expect(week.budgets[0]?.spent.minor).toBe('10000');
  });

  it('rejects malformed period keys', async () => {
    for (const qs of ['?period=2026-13', '?period=foo', '?period=2026-W54', '?period=2026-W00']) {
      expect((await getHome(w.aToken, qs)).status, qs).toBe(400);
    }
  });

  it('keeps uncategorized inflows and net refunds out of the breakdown', async () => {
    await w.add(w.aAccount, -3_000n, '2026-11-02', null);
    await w.add(w.aAccount, 10_000n, '2026-11-03', null); // uncategorized deposit: not a negative spend
    await w.add(w.aAccount, -1_000n, '2026-11-04', 'Shopping');
    await w.add(w.aAccount, 2_000n, '2026-11-05', 'Shopping'); // refund exceeds spend: net <= 0
    await w.add(w.aAccount, -4_000n, '2026-11-05', 'Transport');
    const { home } = await getHome(w.aToken);
    expect(home.breakdown.map((b) => [b.name, b.spent.minor])).toEqual([
      ['Transport', '4000'],
      ['Uncategorized', '3000'],
    ]);
    expect(home.uncategorizedIncome).toEqual({ minor: '10000', currency: 'EUR' });
    expect(home.income).toEqual({ minor: '0', currency: 'EUR' });
  });

  it('breakdown only covers the viewers visible accounts; budgets count every counting account', async () => {
    await budget('Groceries', 'monthly', ['Groceries']);
    await w.add(w.aAccount, -1_000n, '2026-11-02', 'Groceries');
    await w.add(w.bHiddenCounting, -4_000n, '2026-11-02', 'Groceries');
    const a = (await getHome(w.aToken)).home;
    const b = (await getHome(w.bToken)).home;
    expect(a.budgets[0]?.spent.minor).toBe('5000');
    expect(b.budgets[0]?.spent.minor).toBe('5000');
    expect(a.breakdown[0]?.spent.minor).toBe('1000');
    expect(b.breakdown[0]?.spent.minor).toBe('5000');
  });

  it('sync lists own connectors in full and others only when they back household-visible accounts', async () => {
    const own = await getHome(w.aToken);
    const rows = await database.db.select().from(connectors);
    expect(own.home.sync).toHaveLength(2); // A's own + B's (household-visible accounts)
    const mine = own.home.sync.find((s) => s['isOwner'] === true);
    expect(mine).toMatchObject({ type: 'fake', status: 'ok', lastErrorCode: null });
    const theirs = own.home.sync.find((s) => s['isOwner'] === false);
    expect(theirs).toBeDefined();
    expect(Object.keys(theirs as object).sort()).toEqual(
      ['bank', 'id', 'isOwner', 'lastSuccessAt', 'status', 'type'].sort(),
    );
    expect(rows).toHaveLength(2);
    // B's connector backs household accounts, so A sees it; make B's accounts all owner_only: invisible
    await database.pool.query(`update accounts set visibility = 'owner_only'`);
    const hidden = await getHome(w.aToken);
    expect(hidden.home.sync).toHaveLength(1);
  });

  it('requires authentication', async () => {
    const res = await w.app.inject({ method: 'GET', url: '/api/v1/home' });
    expect(res.statusCode).toBe(401);
  });

  describe('daily series', () => {
    const at = async (iso: string) => {
      await w.app.close();
      w = await createWorld(database, { now: () => new Date(iso) });
    };
    const sum = (xs: { spent: Money }[]) => xs.reduce((a, x) => a + BigInt(x.spent.minor), 0n);

    it('daily has one entry per elapsed day with zeros, and sums to the breakdown total', async () => {
      await at('2026-11-12T12:00:00Z');
      await w.add(w.aAccount, -1_000n, '2026-11-01', 'Groceries');
      await w.add(w.aAccount, -2_500n, '2026-11-03', 'Shopping');
      await w.add(w.aAccount, -400n, '2026-11-12', 'Transport');
      const { home } = await getHome(w.aToken);
      expect(home.daily).toHaveLength(12);
      expect(home.daily[0]).toEqual({
        date: '2026-11-01',
        spent: { minor: '1000', currency: 'EUR' },
      });
      expect(home.daily[1]?.spent.minor).toBe('0');
      expect(home.daily[11]?.date).toBe('2026-11-12');
      expect(sum(home.daily)).toBe(sum(home.breakdown));
    });

    it('on the 1st before any spending daily is a single zero entry', async () => {
      await at('2026-11-01T08:00:00Z');
      const { home } = await getHome(w.aToken);
      expect(home.daily).toEqual([{ date: '2026-11-01', spent: { minor: '0', currency: 'EUR' } }]);
    });

    it('previous period daily covers the whole month', async () => {
      await at('2026-11-12T12:00:00Z');
      await w.add(w.aAccount, -700n, '2026-10-31', 'Groceries');
      const { home } = await getHome(w.aToken, '?period=previous');
      expect(home.daily).toHaveLength(31);
      expect(home.daily[0]?.date).toBe('2026-10-01');
      expect(home.daily[30]).toEqual({
        date: '2026-10-31',
        spent: { minor: '700', currency: 'EUR' },
      });
    });

    it('a booking at 23:30 Berlin on the last day of a month lands on that day', async () => {
      await at('2026-11-12T12:00:00Z');
      await w.add(w.aAccount, -900n, '2026-10-31', 'Groceries');
      const { home } = await getHome(w.aToken, '?period=previous');
      const last = home.daily.at(-1);
      expect(last?.date).toBe('2026-10-31');
      expect(last?.spent.minor).toBe('900');
      expect(home.daily).toHaveLength(31);
    });

    it('transfers and income are not in daily', async () => {
      await at('2026-11-12T12:00:00Z');
      await w.add(w.aAccount, 250_000n, '2026-11-01', 'Income');
      await w.add(w.aAccount, -50_000n, '2026-11-02', 'Transfer');
      await w.add(w.aAccount, 5_000n, '2026-11-03', null); // uncategorized deposit
      await w.add(w.aAccount, -300n, '2026-11-04', 'Groceries');
      const { home } = await getHome(w.aToken);
      expect(sum(home.daily)).toBe(300n);
    });

    it('foreign currency without an FX rate is left out of daily and sets fxMissing', async () => {
      await at('2026-11-12T12:00:00Z');
      await w.add(w.aAccount, -1_000n, '2026-11-02', 'Groceries', { currency: 'ZAR' });
      await w.add(w.aAccount, -200n, '2026-11-02', 'Groceries');
      const { home } = await getHome(w.aToken);
      expect(home.fxMissing).toBe(true);
      expect(home.daily[1]?.spent.minor).toBe('200');
      expect(sum(home.daily)).toBe(200n);
    });

    it('breakdown entries carry icon and colour; uncategorized has nulls', async () => {
      await at('2026-11-12T12:00:00Z');
      await database.db
        .update(categories)
        .set({ icon: 'cart', color: 'green' })
        .where(eq(categories.id, w.cat['Groceries'] as string));
      await w.add(w.aAccount, -1_000n, '2026-11-02', 'Groceries');
      await w.add(w.aAccount, -500n, '2026-11-02', null);
      const { home } = await getHome(w.aToken);
      const g = home.breakdown.find((b) => b.name === 'Groceries');
      expect(g).toMatchObject({ icon: 'cart', color: 'green' });
      const u = home.breakdown.find((b) => b.categoryId === null);
      expect(u).toMatchObject({ icon: null, color: null });
    });
  });
});

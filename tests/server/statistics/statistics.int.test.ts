import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createWorld, type World } from '../../support/budget-world.js';
import { startTestDatabase, type TestDatabase } from '../../support/postgres.js';

interface Money {
  minor: string;
  currency: string;
}
interface Stats {
  months: {
    key: string;
    start: string;
    end: string;
    partial: boolean;
    income: Money;
    spending: Money;
  }[];
  averageKept: Money | null;
  categories: {
    categoryId: string | null;
    name: string;
    icon: string | null;
    color: string | null;
    spent: Money;
    previousSpent: Money;
  }[];
  fxMissing: boolean;
}

let database: TestDatabase;
let w: World;
const NOW = new Date('2026-11-12T12:00:00Z');

beforeAll(async () => {
  database = await startTestDatabase();
}, 120_000);
afterAll(async () => {
  await w?.app.close();
  await database.stop();
});
beforeEach(async () => {
  await w?.app.close();
  w = await createWorld(database, { now: () => NOW });
});

const getStats = async (token: string, qs = '') => {
  const res = await w.call('GET', `/statistics${qs}`, token);
  return { status: res.status, stats: res.json as Stats, body: res.body };
};

describe('GET /statistics', () => {
  it('six months by default, oldest first, current month partial', async () => {
    await w.add(w.aAccount, -1_000n, '2026-06-01', 'Groceries');
    const { status, stats } = await getStats(w.aToken);
    expect(status).toBe(200);
    expect(stats.months.map((m) => m.key)).toEqual([
      '2026-06',
      '2026-07',
      '2026-08',
      '2026-09',
      '2026-10',
      '2026-11',
    ]);
    expect(stats.months.map((m) => m.partial)).toEqual([false, false, false, false, false, true]);
    expect(stats.months[5]).toMatchObject({
      start: '2026-10-31T23:00:00.000Z',
      end: '2026-11-30T23:00:00.000Z',
    });
    expect(stats.months[0]?.spending).toEqual({ minor: '1000', currency: 'EUR' });
  });

  it('months=12 covers twelve months', async () => {
    await w.add(w.aAccount, -1_000n, '2025-12-05', 'Groceries');
    const { stats } = await getStats(w.aToken, '?months=12');
    expect(stats.months).toHaveLength(12);
    expect(stats.months[0]?.key).toBe('2025-12');
  });

  it('months before the first visible transaction are omitted', async () => {
    await w.add(w.aAccount, -1_000n, '2026-09-15', 'Groceries');
    const { stats } = await getStats(w.aToken);
    expect(stats.months.map((m) => m.key)).toEqual(['2026-09', '2026-10', '2026-11']);
  });

  it('averageKept uses complete months only', async () => {
    for (const month of ['2026-09', '2026-10']) {
      await w.add(w.aAccount, 200_000n, `${month}-01`, 'Income');
      await w.add(w.aAccount, -150_000n, `${month}-05`, 'Groceries');
    }
    await w.add(w.aAccount, -999_999n, '2026-11-02', 'Shopping');
    const { stats } = await getStats(w.aToken);
    expect(stats.averageKept).toEqual({ minor: '50000', currency: 'EUR' });
    expect(stats.months[2]).toMatchObject({ key: '2026-11', partial: true });
  });

  it('averageKept is null with no complete month', async () => {
    await w.add(w.aAccount, -1_000n, '2026-11-02', 'Groceries');
    const { stats } = await getStats(w.aToken);
    expect(stats.months).toHaveLength(1);
    expect(stats.averageKept).toBeNull();
  });

  it('income counts income categories and uncategorised positive amounts; transfers are ignored', async () => {
    await w.add(w.aAccount, 100_000n, '2026-10-01', 'Income');
    await w.add(w.aAccount, 5_000n, '2026-10-02', null);
    await w.add(w.aAccount, -77_000n, '2026-10-03', 'Transfer');
    const { stats } = await getStats(w.aToken);
    const oct = stats.months.find((m) => m.key === '2026-10');
    expect(oct?.income).toEqual({ minor: '105000', currency: 'EUR' });
    expect(oct?.spending.minor).toBe('0');
  });

  it("a month's spending equals the home breakdown total (net <= 0 categories dropped)", async () => {
    await w.add(w.aAccount, -4_000n, '2026-10-05', 'Groceries');
    await w.add(w.aAccount, -1_000n, '2026-10-06', 'Shopping');
    await w.add(w.aAccount, 3_000n, '2026-10-07', 'Shopping'); // net refund: dropped
    const { stats } = await getStats(w.aToken);
    expect(stats.months.find((m) => m.key === '2026-10')?.spending.minor).toBe('4000');
    const home = await w.call('GET', '/home?period=2026-10', w.aToken);
    const total = (home.json as { breakdown: { spent: Money }[] }).breakdown.reduce(
      (a, b) => a + BigInt(b.spent.minor),
      0n,
    );
    expect(total).toBe(4_000n);
  });

  it('previousSpent covers the six months before the window', async () => {
    await w.add(w.aAccount, -7_000n, '2026-02-10', 'Groceries'); // previous window (2025-12..2026-05)
    await w.add(w.aAccount, -3_000n, '2026-10-10', 'Groceries');
    await w.add(w.aAccount, -500n, '2026-01-10', 'Transport'); // previous only
    await w.add(w.aAccount, -9_000n, '2025-11-30', 'Shopping'); // before the previous window
    const { stats } = await getStats(w.aToken);
    const g = stats.categories.find((c) => c.name === 'Groceries');
    expect(g?.spent.minor).toBe('3000');
    expect(g?.previousSpent.minor).toBe('7000');
    const t = stats.categories.find((c) => c.name === 'Transport');
    expect(t?.spent.minor).toBe('0');
    expect(t?.previousSpent.minor).toBe('500');
    expect(stats.categories.find((c) => c.name === 'Shopping')).toBeUndefined();
  });

  it('categories sorted by spent desc and drop all-zero entries', async () => {
    await w.add(w.aAccount, -1_000n, '2026-10-10', 'Transport');
    await w.add(w.aAccount, -5_000n, '2026-10-11', 'Groceries');
    await w.add(w.aAccount, 2_000n, '2026-10-12', 'Shopping'); // net refund only
    const { stats } = await getStats(w.aToken);
    expect(stats.categories.map((c) => [c.name, c.spent.minor])).toEqual([
      ['Groceries', '5000'],
      ['Transport', '1000'],
    ]);
  });

  it('invisible accounts never count', async () => {
    await w.add(w.bHiddenCounting, -88_000n, '2026-10-10', 'Groceries');
    await w.add(w.aAccount, -1_000n, '2026-10-10', 'Groceries');
    const a = await getStats(w.aToken);
    expect(a.stats.categories.map((c) => c.spent.minor)).toEqual(['1000']);
    expect(a.stats.months.find((m) => m.key === '2026-10')?.spending.minor).toBe('1000');
    const b = await getStats(w.bToken);
    expect(b.stats.months.find((m) => m.key === '2026-10')?.spending.minor).toBe('89000');
  });

  it('months=7 is rejected', async () => {
    const { status } = await getStats(w.aToken, '?months=7');
    expect(status).toBe(400);
  });

  it('empty household returns no months and a null average', async () => {
    const { status, stats } = await getStats(w.aToken);
    expect(status).toBe(200);
    expect(stats).toEqual({ months: [], averageKept: null, categories: [], fxMissing: false });
  });

  it('requires authentication', async () => {
    const res = await w.app.inject({ method: 'GET', url: '/api/v1/statistics' });
    expect(res.statusCode).toBe(401);
  });
});

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { evaluateAlerts } from '@budgedino/server/budgets/alerts';
import { budgets, notifications, transactions } from '@budgedino/server/db/schema';
import { decryptString } from '@budgedino/server/crypto';
import { createFakeConnector } from '@budgedino/server/connectors/fake/fake-connector';
import { createConnectorRegistry } from '@budgedino/server/connectors/registry';
import { refreshFxRates } from '@budgedino/server/fx/service';
import {
  createWorld,
  CANARY_PAYEE,
  fixtureFxSource,
  NOW,
  type World,
} from '../../support/budget-world.js';
import { startTestDatabase, type TestDatabase } from '../../support/postgres.js';
import { seedFakeConnector } from '../../support/sync.js';

interface Money {
  minor: string;
  currency: string;
}
interface BudgetView {
  id: string;
  name: string;
  categoryIds: string[];
  periodKind: string;
  amount: Money;
  spent: Money;
  ratio: string;
  fxMissing: boolean;
  period: { key: string; start: string; end: string };
}
interface HomeView {
  period: { key: string };
  budgets: BudgetView[];
  breakdown: {
    categoryId: string | null;
    name: string;
    spent: Money;
    icon: string | null;
    color: string | null;
  }[];
  income: Money;
  fxMissing: boolean;
}
interface NotificationsView {
  notifications: { id: string; kind: string; body: string; createdAt: string }[];
  nextCursor: string | null;
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

async function createBudget(
  token: string,
  over: Record<string, unknown> = {},
): Promise<BudgetView> {
  const res = await w.call('POST', '/budgets', token, {
    name: 'Groceries',
    categoryIds: [w.cat['Groceries']],
    periodKind: 'monthly',
    amount: { minor: '50000', currency: 'EUR' },
    ...over,
  });
  expect(res.status, res.body).toBe(201);
  return (res.json as { budget: BudgetView }).budget;
}

const home = async (token: string, qs = '') =>
  (await w.call('GET', `/home${qs}`, token)).json as HomeView;
const budgetOf = async (token: string, id: string) =>
  ((await w.call('GET', '/budgets', token)).json as { budgets: BudgetView[] }).budgets.find(
    (b) => b.id === id,
  ) as BudgetView;

describe('spent and ratio', () => {
  it('Groceries 500 monthly with 200 + 140 spent shows 340 and ratio 0.6800', async () => {
    const b = await createBudget(w.aToken);
    await w.add(w.aAccount, -20_000n, '2026-11-02', 'Groceries');
    await w.add(w.bAccount, -14_000n, '2026-11-05', 'Groceries');
    await w.add(w.aAccount, -99_900n, '2026-10-30', 'Groceries'); // previous period
    await w.add(w.aAccount, -5_000n, '2026-11-03', 'Shopping'); // other category
    for (const token of [w.aToken, w.bToken]) {
      const view = await budgetOf(token, b.id);
      expect(view.spent).toEqual({ minor: '34000', currency: 'EUR' });
      expect(view.amount).toEqual({ minor: '50000', currency: 'EUR' });
      expect(view.ratio).toBe('0.6800');
      expect(view.fxMissing).toBe(false);
      expect(view.period.key).toBe('2026-11');
    }
    const h = await home(w.aToken);
    expect(h.budgets[0]).toMatchObject({ name: 'Groceries', ratio: '0.6800' });
    expect(h.period.key).toBe('2026-11');
  });

  it('a refund reduces spent, shows in the breakdown, and is not income', async () => {
    const b = await createBudget(w.aToken);
    await w.add(w.aAccount, -20_000n, '2026-11-02', 'Groceries');
    await w.add(w.bAccount, -14_000n, '2026-11-05', 'Groceries');
    await w.add(w.aAccount, 2_000n, '2026-11-06', 'Groceries'); // refund +20
    await w.add(w.aAccount, 300_000n, '2026-11-01', 'Income');
    const view = await budgetOf(w.aToken, b.id);
    expect(view.spent.minor).toBe('32000');
    expect(view.ratio).toBe('0.6400');
    const h = await home(w.aToken);
    expect(h.breakdown).toEqual([
      {
        categoryId: w.cat['Groceries'],
        name: 'Groceries',
        icon: null,
        color: null,
        spent: { minor: '32000', currency: 'EUR' },
      },
    ]);
    expect(h.income).toEqual({ minor: '300000', currency: 'EUR' });
  });

  it('spent may go below zero (raw) while ratio is clamped at 0', async () => {
    const b = await createBudget(w.aToken);
    await w.add(w.aAccount, 1_500n, '2026-11-06', 'Groceries');
    const view = await budgetOf(w.aToken, b.id);
    expect(view.spent.minor).toBe('-1500');
    expect(view.ratio).toBe('0.0000');
  });

  it('counts pending transactions, excludes transfers and non-counting accounts', async () => {
    const b = await createBudget(w.aToken);
    await w.add(w.aAccount, -10_000n, '2026-11-02', 'Groceries', { status: 'pending' });
    const transfer = await w.add(w.aAccount, -77_700n, '2026-11-02', 'Groceries');
    await database.db
      .update(transactions)
      .set({ transferGroupId: '8a1a4bc0-6d5e-4f0a-8f2a-0a6f9d1e2c3b' })
      .where(eq(transactions.id, transfer));
    await w.add(w.bNotCounting, -55_500n, '2026-11-02', 'Groceries');
    const view = await budgetOf(w.bToken, b.id);
    expect(view.spent.minor).toBe('10000');
    // the non-counting account still shows in its owner's own breakdown (the breakdown is about visibility)
    const h = await home(w.bToken);
    expect(h.breakdown[0]?.spent.minor).toBe('65500');
  });

  it('only counts split parts, by their own categories; the parent category is ignored', async () => {
    const b = await createBudget(w.aToken);
    const tx = await w.add(w.aAccount, -10_000n, '2026-11-02', 'Groceries');
    const res = await w.call('POST', `/transactions/${tx}/splits`, w.aToken, {
      parts: [
        { categoryId: w.cat['Shopping'], amount: { minor: '-7000', currency: 'EUR' } },
        { categoryId: w.cat['Groceries'], amount: { minor: '-3000', currency: 'EUR' } },
      ],
    });
    expect(res.status, res.body).toBe(200);
    expect((await budgetOf(w.aToken, b.id)).spent.minor).toBe('3000');
    const h = await home(w.aToken);
    expect(h.breakdown.map((x) => [x.name, x.spent.minor])).toEqual([
      ['Shopping', '7000'],
      ['Groceries', '3000'],
    ]);
  });

  it('weekly budgets use the ISO week in the household timezone', async () => {
    const b = await createBudget(w.aToken, { name: 'Weekly', periodKind: 'weekly' });
    await w.add(w.aAccount, -1_000n, '2026-11-09', 'Groceries'); // Monday of W46
    await w.add(w.aAccount, -2_000n, '2026-11-08', 'Groceries'); // Sunday of W45
    const view = await budgetOf(w.aToken, b.id);
    expect(view.period.key).toBe('2026-W46');
    expect(view.spent.minor).toBe('1000');
  });
});

describe('FX', () => {
  it('converts USD 10.00 at 1.0800 (latest earlier rate on a Saturday) to EUR 9.26', async () => {
    const b = await createBudget(w.aToken);
    await w.add(w.aAccount, -1_000n, '2026-11-07', 'Groceries', { currency: 'USD' });
    const view = await budgetOf(w.aToken, b.id);
    expect(view.spent).toEqual({ minor: '926', currency: 'EUR' });
    expect(view.fxMissing).toBe(false);
  });

  it('excludes a transaction without a rate and flags fxMissing, never throwing', async () => {
    const b = await createBudget(w.aToken);
    await w.add(w.aAccount, -10_000n, '2026-11-02', 'Groceries');
    await w.add(w.aAccount, -5_000n, '2026-11-03', 'Groceries', { currency: 'ZAR' });
    const view = await budgetOf(w.aToken, b.id);
    expect(view.spent.minor).toBe('10000');
    expect(view.fxMissing).toBe(true);
    expect((await home(w.aToken)).fxMissing).toBe(true);
  });

  it('a rate dated after the booking date is not used', async () => {
    const b = await createBudget(w.aToken);
    await w.add(w.aAccount, -1_000n, '2026-08-01', 'Groceries', { currency: 'USD' });
    // period of that date is August; rates start 2026-08-12 -> missing
    const res = await w.call('GET', '/home?period=2026-08', w.aToken);
    const h = res.json as HomeView;
    expect(h.budgets.find((x) => x.id === b.id)?.fxMissing).toBe(true);
    expect(h.budgets.find((x) => x.id === b.id)?.spent.minor).toBe('0');
  });

  it('refresh upserts rates idempotently', async () => {
    await refreshFxRates(database.db, fixtureFxSource);
    const { rows } = await database.pool.query<{ n: string }>('select count(*) n from fx_rates');
    expect(rows[0]?.n).toBe('320');
  });
});

describe('owner_only account that counts toward budgets', () => {
  it('counts in totals for both members but is absent from A breakdown and notifications', async () => {
    const b = await createBudget(w.aToken, { amount: { minor: '10000', currency: 'EUR' } });
    await w.add(w.aAccount, -2_000n, '2026-11-02', 'Groceries');
    await w.add(w.bHiddenCounting, -7_000n, '2026-11-03', 'Groceries', {
      counterparty: CANARY_PAYEE,
    });
    await w.add(w.bHiddenCounting, -1_234n, '2026-11-04', 'Shopping');
    for (const token of [w.aToken, w.bToken]) {
      expect((await budgetOf(token, b.id)).spent.minor).toBe('9000');
    }
    const a = await w.call('GET', '/home', w.aToken);
    expect((a.json as HomeView).breakdown).toEqual([
      {
        categoryId: w.cat['Groceries'],
        name: 'Groceries',
        icon: null,
        color: null,
        spent: { minor: '2000', currency: 'EUR' },
      },
    ]);
    expect(a.body).not.toContain(CANARY_PAYEE);
    const owner = await home(w.bToken);
    expect(owner.breakdown.map((x) => [x.name, x.spent.minor])).toEqual([
      ['Groceries', '9000'], // A's household account (2000) + B's own hidden one (7000)
      ['Shopping', '1234'],
    ]);

    // cross 80%: notifications carry neither amounts nor the hidden payee
    await w.add(w.aAccount, -500n, '2026-11-06', 'Groceries'); // 95%
    await evaluateAlerts(database.db, w.keyring, w.householdId, NOW);
    const aNotes = await w.call('GET', '/notifications', w.aToken);
    expect((aNotes.json as NotificationsView).notifications.map((n) => n.body)).toEqual([
      'Groceries reached 80%',
    ]);
    expect(aNotes.body).not.toContain(CANARY_PAYEE);
  });
});

describe('alerts', () => {
  const bodies = async (token: string) =>
    ((await w.call('GET', '/notifications', token)).json as NotificationsView).notifications.map(
      (n) => n.body,
    );

  it('crossing 80% creates exactly one notification per member; a second ingest does not duplicate', async () => {
    await createBudget(w.aToken);
    await w.add(w.aAccount, -39_000n, '2026-11-02', 'Groceries');
    await evaluateAlerts(database.db, w.keyring, w.householdId, NOW);
    expect(await bodies(w.aToken)).toEqual([]);

    await w.add(w.aAccount, -2_000n, '2026-11-03', 'Groceries'); // 410 / 500 = 82%
    await evaluateAlerts(database.db, w.keyring, w.householdId, NOW);
    await evaluateAlerts(database.db, w.keyring, w.householdId, NOW);
    expect(await bodies(w.aToken)).toEqual(['Groceries reached 80%']);
    expect(await bodies(w.bToken)).toEqual(['Groceries reached 80%']);

    await w.add(w.aAccount, -9_000n, '2026-11-04', 'Groceries'); // 500 / 500
    await evaluateAlerts(database.db, w.keyring, w.householdId, NOW);
    await evaluateAlerts(database.db, w.keyring, w.householdId, NOW);
    expect(await bodies(w.aToken)).toEqual(['Groceries reached 80%', 'Groceries reached 100%']);
    const rows = await database.db.select().from(notifications);
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.kind === 'budget_threshold')).toBe(true);
  });

  it('a new period gets its own notification (dedup key includes the period)', async () => {
    await createBudget(w.aToken);
    await w.add(w.aAccount, -45_000n, '2026-11-02', 'Groceries');
    await evaluateAlerts(database.db, w.keyring, w.householdId, NOW);
    await w.add(w.aAccount, -45_000n, '2026-12-02', 'Groceries');
    await evaluateAlerts(database.db, w.keyring, w.householdId, new Date('2026-12-03T12:00:00Z'));
    expect(await bodies(w.aToken)).toEqual(['Groceries reached 80%', 'Groceries reached 80%']);
  });

  it('the stored body is encrypted at rest', async () => {
    await createBudget(w.aToken);
    await w.add(w.aAccount, -45_000n, '2026-11-02', 'Groceries');
    await evaluateAlerts(database.db, w.keyring, w.householdId, NOW);
    const [row] = await database.db.select().from(notifications);
    expect(row?.bodyEnc?.toString('utf8')).not.toContain('Groceries');
    expect(
      decryptString(w.dk, row?.bodyEnc as Buffer, {
        table: 'notifications',
        column: 'body',
        rowId: row?.id as string,
      }),
    ).toBe('Groceries reached 80%');
  });

  it('runs after each ingest (default onIngested wiring)', async () => {
    await w.app.close();
    const registry = createConnectorRegistry([createFakeConnector()]);
    w = await createWorld(database, { registry });
    await createBudget(w.aToken, { amount: { minor: '10000', currency: 'EUR' } });
    const { connectorId } = await seedFakeConnector(database.db, w.keyring, w.householdId, w.bId, {
      accountRef: 'fake-wire',
      transactions: [
        {
          providerId: 'p1',
          status: 'booked',
          bookingDate: '2026-11-05',
          amountMinor: '-9000',
          currency: 'EUR',
          counterparty: 'REWE Markt',
          mcc: '5411',
        },
      ],
    });
    const res = await w.call('POST', `/connectors/${connectorId}/sync`, w.bToken);
    expect(res.status, res.body).toBe(202);
    await w.app.ctx.sync.idle();
    expect(await bodies(w.aToken)).toEqual(['Groceries reached 80%']);
    expect(await bodies(w.bToken)).toEqual(['Groceries reached 80%']);
  });
});

describe('budget CRUD', () => {
  it('members may read but not write; admins create, patch and archive', async () => {
    const b = await createBudget(w.aToken);
    expect(
      (
        await w.call('POST', '/budgets', w.bToken, {
          name: 'x',
          categoryIds: [w.cat['Groceries']],
          periodKind: 'monthly',
          amount: { minor: '100', currency: 'EUR' },
        })
      ).status,
    ).toBe(403);
    expect((await w.call('PATCH', `/budgets/${b.id}`, w.bToken, { name: 'y' })).status).toBe(403);
    expect((await w.call('DELETE', `/budgets/${b.id}`, w.bToken)).status).toBe(403);
    expect((await w.call('GET', '/budgets', w.bToken)).status).toBe(200);

    const patched = await w.call('PATCH', `/budgets/${b.id}`, w.aToken, {
      name: 'Food',
      amount: { minor: '60000', currency: 'EUR' },
    });
    expect(patched.status, patched.body).toBe(200);
    expect((patched.json as { budget: BudgetView }).budget).toMatchObject({
      name: 'Food',
      amount: { minor: '60000', currency: 'EUR' },
    });

    expect((await w.call('DELETE', `/budgets/${b.id}`, w.aToken)).status).toBe(200);
    expect(
      ((await w.call('GET', '/budgets', w.aToken)).json as { budgets: unknown[] }).budgets,
    ).toEqual([]);
    const [row] = await database.db.select().from(budgets).where(eq(budgets.id, b.id));
    expect(row?.archived).toBe(true);
    expect((await w.call('PATCH', `/budgets/${b.id}`, w.aToken, { name: 'z' })).status).toBe(404);
    expect((await w.call('DELETE', `/budgets/${b.id}`, w.aToken)).status).toBe(404);
  });

  it('encrypts the amount at rest', async () => {
    const b = await createBudget(w.aToken, { amount: { minor: '123456', currency: 'EUR' } });
    const [row] = await database.db.select().from(budgets).where(eq(budgets.id, b.id));
    expect(row?.amountMinorEnc.toString('utf8')).not.toContain('123456');
  });

  it('rejects invalid input with 422', async () => {
    const base = {
      name: 'x',
      categoryIds: [w.cat['Groceries']],
      periodKind: 'monthly',
      amount: { minor: '100', currency: 'EUR' },
    };
    const post = (over: Record<string, unknown>) =>
      w.call('POST', '/budgets', w.aToken, { ...base, ...over });
    expect((await post({ amount: { minor: '0', currency: 'EUR' } })).status).toBe(422);
    expect((await post({ amount: { minor: '-5', currency: 'EUR' } })).status).toBe(422);
    expect((await post({ amount: { minor: '100', currency: 'USD' } })).status).toBe(422);
    expect((await post({ categoryIds: [w.cat['Income']] })).status).toBe(422);
    expect((await post({ categoryIds: [w.cat['Transfer']] })).status).toBe(422);
    expect((await post({ categoryIds: ['8a1a4bc0-6d5e-4f0a-8f2a-0a6f9d1e2c3b'] })).status).toBe(
      422,
    );
    expect((await post({ categoryIds: [] })).status).toBe(400);
    expect((await post({ periodKind: 'daily' })).status).toBe(400);
    const b = await createBudget(w.aToken);
    expect(
      (await w.call('PATCH', `/budgets/${b.id}`, w.aToken, { categoryIds: [w.cat['Income']] }))
        .status,
    ).toBe(422);
    expect(
      (
        await w.call('PATCH', `/budgets/${b.id}`, w.aToken, {
          amount: { minor: '5', currency: 'USD' },
        })
      ).status,
    ).toBe(422);
  });

  it("does not accept another household's categories", async () => {
    const { categories: cats } = await import('@budgedino/server/db/schema');
    const { createHousehold } = await import('../../support/factories.js');
    const other = await createHousehold(database.db, w.keyring, 'other');
    const [foreign] = await database.db
      .insert(cats)
      .values({ householdId: other, name: 'Groceries' })
      .returning();
    const res = await w.call('POST', '/budgets', w.aToken, {
      name: 'x',
      categoryIds: [foreign?.id],
      periodKind: 'monthly',
      amount: { minor: '100', currency: 'EUR' },
    });
    expect(res.status).toBe(422);
  });

  it('requires authentication', async () => {
    const res = await w.app.inject({ method: 'GET', url: '/api/v1/budgets' });
    expect(res.statusCode).toBe(401);
  });
});

describe('notification polling', () => {
  async function seedNotes(memberId: string, count: number) {
    for (let i = 0; i < count; i += 1) {
      const { encryptField } = await import('@budgedino/server/crypto');
      const { newId } = await import('@budgedino/server/db/ids');
      const id = newId();
      await database.db.insert(notifications).values({
        id,
        householdId: w.householdId,
        memberId,
        kind: 'budget_threshold',
        bodyEnc: encryptField(w.dk, `note ${i}`, {
          table: 'notifications',
          column: 'body',
          rowId: id,
        }),
      });
    }
  }

  it('returns only the callers own pending notifications, paged by a keyset cursor (max 100)', async () => {
    await seedNotes(w.aId, 5);
    await seedNotes(w.bId, 2);
    const first = (await w.call('GET', '/notifications?limit=3', w.aToken))
      .json as NotificationsView;
    expect(first.notifications.map((n) => n.body)).toEqual(['note 0', 'note 1', 'note 2']);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = (
      await w.call(
        'GET',
        `/notifications?limit=3&since=${encodeURIComponent(first.nextCursor as string)}`,
        w.aToken,
      )
    ).json as NotificationsView;
    expect(second.notifications.map((n) => n.body)).toEqual(['note 3', 'note 4']);
    const done = (
      await w.call(
        'GET',
        `/notifications?since=${encodeURIComponent(second.nextCursor as string)}`,
        w.aToken,
      )
    ).json as NotificationsView;
    expect(done.notifications).toEqual([]);
    expect(done.nextCursor).toBe(second.nextCursor);
    expect((await w.call('GET', '/notifications?limit=101', w.aToken)).status).toBe(400);
    expect((await w.call('GET', '/notifications?since=garbage', w.aToken)).status).toBe(400);
    const b = (await w.call('GET', '/notifications', w.bToken)).json as NotificationsView;
    expect(b.notifications).toHaveLength(2);
  });

  it('ack marks only the callers own ids delivered; foreign ids are ignored silently', async () => {
    await seedNotes(w.aId, 2);
    await seedNotes(w.bId, 1);
    const aList = (await w.call('GET', '/notifications', w.aToken)).json as NotificationsView;
    const bList = (await w.call('GET', '/notifications', w.bToken)).json as NotificationsView;
    const [a0, a1] = aList.notifications;
    const res = await w.call('POST', '/notifications/ack', w.aToken, {
      ids: [a0?.id, bList.notifications[0]?.id],
    });
    expect(res.status, res.body).toBe(200);
    const rows = await database.db.select().from(notifications);
    const delivered = rows.filter((r) => r.deliveredAt !== null).map((r) => r.id);
    expect(delivered).toEqual([a0?.id]);
    expect(
      (
        (await w.call('GET', '/notifications', w.aToken)).json as NotificationsView
      ).notifications.map((n) => n.id),
    ).toEqual([a1?.id]);
    expect(
      (
        await database.db
          .select()
          .from(notifications)
          .where(and(eq(notifications.memberId, w.bId)))
      ).every((r) => r.deliveredAt === null),
    ).toBe(true);
    expect((await w.call('POST', '/notifications/ack', w.aToken, { ids: ['nope'] })).status).toBe(
      400,
    );
  });
});

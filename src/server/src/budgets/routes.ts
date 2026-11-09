import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  budgetArchivedResponse,
  budgetIdParams,
  budgetListResponse,
  budgetResponse,
  createBudgetRequest,
  errorResponse,
  money,
  patchBudgetRequest,
  periodFor,
  type Money,
} from '@budgedino/shared';
import type { Db } from '../db/client.js';
import { categories } from '../db/schema.js';
import type { AuthContext } from '../deps.js';
import { HttpError } from '../http/errors.js';
import {
  archiveBudget,
  budgetViews,
  getBudget,
  householdSettings,
  insertBudget,
  spentFor,
  toView,
  updateBudget,
  type HouseholdSettings,
} from './service.js';

const notFound = () => new HttpError(404, 'not_found', 'Budget not found');

function authOf(req: { auth: AuthContext | null }): AuthContext {
  if (!req.auth) throw new Error('unreachable: the access hook authenticates');
  return req.auth;
}

/** Positive amount in the household base currency, else 422. */
function validAmount(
  input: { minor: string; currency: string },
  settings: HouseholdSettings,
): Money {
  const minor = BigInt(input.minor);
  if (minor <= 0n) throw new HttpError(422, 'invalid_amount', 'Amount must be positive');
  if (input.currency !== settings.baseCurrency) {
    throw new HttpError(422, 'invalid_currency', 'Budgets use the household base currency');
  }
  return money(minor, input.currency);
}

/** Categories must belong to the household and be spending categories (neither income nor transfer). */
async function requireSpendingCategories(
  db: Db,
  householdId: string,
  ids: readonly string[],
): Promise<void> {
  const unique = [...new Set(ids)];
  const rows = await db
    .select({ id: categories.id, isIncome: categories.isIncome, isTransfer: categories.isTransfer })
    .from(categories)
    .where(and(eq(categories.householdId, householdId), inArray(categories.id, unique)));
  if (rows.length !== unique.length || rows.some((c) => c.isIncome || c.isTransfer)) {
    throw new HttpError(
      422,
      'invalid_categories',
      'Categories must exist in the household and be neither income nor transfer',
    );
  }
}

export function budgetRoutes(app: FastifyInstance): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const security = [{ bearer: [] }];

  async function viewOf(auth: AuthContext, id: string) {
    const { db, keyring, now } = app.ctx;
    const dk = await keyring.forHousehold(auth.householdId);
    const budget = await getBudget(db, dk, auth.householdId, id);
    if (!budget) throw notFound();
    const settings = await householdSettings(db, auth.householdId);
    const period = periodFor(now(), budget.periodKind, settings.timezone);
    return toView(budget, period, await spentFor(db, dk, budget, period, settings));
  }

  r.get(
    '/budgets',
    {
      config: { access: 'member' },
      schema: {
        tags: ['budgets'],
        security,
        response: { 200: budgetListResponse, '4xx': errorResponse },
      },
    },
    async (req) => {
      const auth = authOf(req);
      const { db, keyring, now } = app.ctx;
      const dk = await keyring.forHousehold(auth.householdId);
      const settings = await householdSettings(db, auth.householdId);
      const { views } = await budgetViews(db, dk, auth.householdId, now(), 'current', settings);
      return { budgets: views };
    },
  );

  r.post(
    '/budgets',
    {
      config: { access: 'admin' },
      schema: {
        tags: ['budgets'],
        security,
        body: createBudgetRequest,
        response: { 201: budgetResponse, '4xx': errorResponse },
      },
    },
    async (req, reply) => {
      const auth = authOf(req);
      const { db, keyring } = app.ctx;
      const dk = await keyring.forHousehold(auth.householdId);
      const settings = await householdSettings(db, auth.householdId);
      const amount = validAmount(req.body.amount, settings);
      await requireSpendingCategories(db, auth.householdId, req.body.categoryIds);
      const created = await insertBudget(db, dk, auth.householdId, {
        name: req.body.name,
        categoryIds: req.body.categoryIds,
        periodKind: req.body.periodKind,
        amount,
      });
      return reply.code(201).send({ budget: await viewOf(auth, created.id) });
    },
  );

  r.patch(
    '/budgets/:id',
    {
      config: { access: 'admin' },
      schema: {
        tags: ['budgets'],
        security,
        params: budgetIdParams,
        body: patchBudgetRequest,
        response: { 200: budgetResponse, '4xx': errorResponse },
      },
    },
    async (req) => {
      const auth = authOf(req);
      const { db, keyring } = app.ctx;
      const dk = await keyring.forHousehold(auth.householdId);
      const settings = await householdSettings(db, auth.householdId);
      const { amount, ...rest } = req.body;
      if (!(await getBudget(db, dk, auth.householdId, req.params.id))) throw notFound();
      if (rest.categoryIds) await requireSpendingCategories(db, auth.householdId, rest.categoryIds);
      const updated = await updateBudget(db, dk, auth.householdId, req.params.id, {
        ...rest,
        ...(amount ? { amount: validAmount(amount, settings) } : {}),
      });
      if (!updated) throw notFound();
      return { budget: await viewOf(auth, updated.id) };
    },
  );

  r.delete(
    '/budgets/:id',
    {
      config: { access: 'admin' },
      schema: {
        tags: ['budgets'],
        security,
        params: budgetIdParams,
        response: { 200: budgetArchivedResponse, '4xx': errorResponse },
      },
    },
    async (req) => {
      const auth = authOf(req);
      if (!(await archiveBudget(app.ctx.db, auth.householdId, req.params.id))) throw notFound();
      return { id: req.params.id, archived: true as const };
    },
  );
}

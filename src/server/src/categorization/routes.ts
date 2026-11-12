import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  categoryIdParams,
  categoryListResponse,
  categoryResponse,
  createCategoryRequest,
  errorResponse,
  listTransactionsQuery,
  listTransactionsResponse,
  patchCategoryRequest,
  patchTransactionRequest,
  patchTransactionResponse,
  ruleIdParams,
  ruleListResponse,
  splitsRequest,
  splitsResponse,
  transactionIdParams,
  type TransactionInfo,
} from '@budgedino/shared';
import { visibleAccountIds, type VisibleAccountIds } from '../access/visibility.js';
import type { Db } from '../db/client.js';
import { categories, rules } from '../db/schema.js';
import { newId } from '../db/ids.js';
import type { AuthContext } from '../deps.js';
import { HttpError } from '../http/errors.js';
import {
  getTransaction,
  listSplits,
  queryTransactions,
  replaceSplits,
  type Split,
  type Transaction,
} from '../repositories/transactions.js';
import type { DataKey } from '../crypto/index.js';
import { createRule, loadOwnRules, recategorizeCounterparty, setCategory } from './rules.js';

const notFound = () => new HttpError(404, 'not_found', 'Transaction not found');
const unknownCategory = () => new HttpError(422, 'unknown_category', 'Category not found');

const categoryKey = (name: string) => name.toLocaleLowerCase('de-DE');

type CategoryRow = typeof categories.$inferSelect;
const toCategoryInfo = (c: CategoryRow) => ({
  id: c.id,
  name: c.name,
  group: c.group,
  isIncome: c.isIncome,
  isTransfer: c.isTransfer,
  archived: c.archived,
});

/** Names are unique per household, case-insensitively (compared the way search is, de-DE). */
async function assertNameFree(db: Db, householdId: string, name: string, exceptId?: string) {
  const rows = await db
    .select({ id: categories.id, name: categories.name })
    .from(categories)
    .where(
      exceptId
        ? and(eq(categories.householdId, householdId), ne(categories.id, exceptId))
        : eq(categories.householdId, householdId),
    );
  if (rows.some((c) => categoryKey(c.name) === categoryKey(name))) {
    throw new HttpError(409, 'category_exists', 'A category with this name already exists');
  }
}

function toInfo(tx: Transaction, splits: readonly Split[]): TransactionInfo {
  return {
    id: tx.id,
    accountId: tx.accountId,
    status: tx.status,
    bookingDate: tx.bookingDate,
    valueDate: tx.valueDate,
    amountMinor: tx.amountMinor.toString(),
    currency: tx.currency,
    counterparty: tx.counterparty,
    purpose: tx.purpose,
    categoryId: tx.categoryId,
    categorySource: tx.categorySource,
    transferGroupId: tx.transferGroupId,
    splits: splits
      .filter((s) => s.transactionId === tx.id)
      .map((s) => ({ id: s.id, categoryId: s.categoryId, amountMinor: s.amountMinor.toString() })),
  };
}

async function loadVisible(
  db: Db,
  dk: DataKey,
  visible: VisibleAccountIds,
  id: string,
): Promise<Transaction> {
  try {
    return await getTransaction(db, dk, visible, id);
  } catch {
    // Missing and hidden are indistinguishable.
    throw notFound();
  }
}

async function requireCategories(db: Db, householdId: string, ids: readonly string[]) {
  const unique = [...new Set(ids)];
  const rows = await db
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.householdId, householdId), inArray(categories.id, unique)));
  if (rows.length !== unique.length) throw unknownCategory();
}

export function categorizationRoutes(app: FastifyInstance): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const security = [{ bearer: [] }];
  const authOf = (req: { auth: AuthContext | null }): AuthContext => {
    if (!req.auth) throw new Error('unreachable: the access hook authenticates');
    return req.auth;
  };

  r.get(
    '/categories',
    {
      config: { access: 'member' },
      schema: {
        tags: ['categories'],
        security,
        response: { 200: categoryListResponse, '4xx': errorResponse },
      },
    },
    async (req) => {
      const auth = authOf(req);
      const rows = await app.ctx.db
        .select()
        .from(categories)
        .where(eq(categories.householdId, auth.householdId))
        .orderBy(asc(categories.name), asc(categories.id));
      return {
        categories: rows.map(toCategoryInfo),
      };
    },
  );

  r.post(
    '/categories',
    {
      config: { access: 'admin' },
      schema: {
        tags: ['categories'],
        security,
        body: createCategoryRequest,
        response: { 201: categoryResponse, '4xx': errorResponse },
      },
    },
    async (req, reply) => {
      const auth = authOf(req);
      const { db } = app.ctx;
      const { name, group, isIncome } = req.body;
      await assertNameFree(db, auth.householdId, name);
      const [row] = await db
        .insert(categories)
        .values({
          id: newId(),
          householdId: auth.householdId,
          name,
          group: group ?? null,
          isIncome: isIncome ?? false,
        })
        .returning();
      if (!row) throw new Error('category insert returned no row');
      return reply.code(201).send({ category: toCategoryInfo(row) });
    },
  );

  r.patch(
    '/categories/:id',
    {
      config: { access: 'admin' },
      schema: {
        tags: ['categories'],
        security,
        params: categoryIdParams,
        body: patchCategoryRequest,
        response: { 200: categoryResponse, '4xx': errorResponse },
      },
    },
    async (req) => {
      const auth = authOf(req);
      const { db } = app.ctx;
      const [current] = await db
        .select()
        .from(categories)
        .where(and(eq(categories.id, req.params.id), eq(categories.householdId, auth.householdId)));
      if (!current) throw new HttpError(404, 'not_found', 'Category not found');
      if (current.isTransfer) {
        throw new HttpError(422, 'category_immutable', 'The Transfer category cannot be changed');
      }
      const { name, group, archived } = req.body;
      if (name !== undefined) await assertNameFree(db, auth.householdId, name, current.id);
      const [row] = await db
        .update(categories)
        .set({
          ...(name === undefined ? {} : { name }),
          ...(group === undefined ? {} : { group }),
          ...(archived === undefined ? {} : { archived }),
        })
        .where(eq(categories.id, current.id))
        .returning();
      if (!row) throw new HttpError(404, 'not_found', 'Category not found');
      return { category: toCategoryInfo(row) };
    },
  );

  r.get(
    '/rules',
    {
      config: { access: 'member' },
      schema: {
        tags: ['rules'],
        security,
        response: { 200: ruleListResponse, '4xx': errorResponse },
      },
    },
    async (req) => {
      const auth = authOf(req);
      const { db, keyring } = app.ctx;
      const dk = await keyring.forHousehold(auth.householdId);
      return { rules: await loadOwnRules(db, dk, auth.householdId, auth.memberId) };
    },
  );

  r.delete(
    '/rules/:id',
    {
      config: { access: 'member' },
      schema: {
        tags: ['rules'],
        security,
        params: ruleIdParams,
        response: { 204: z.null(), '4xx': errorResponse },
      },
    },
    async (req, reply) => {
      const auth = authOf(req);
      // Other members' rules are indistinguishable from missing ones. Past recategorizations stay.
      const deleted = await app.ctx.db
        .delete(rules)
        .where(
          and(
            eq(rules.id, req.params.id),
            eq(rules.householdId, auth.householdId),
            eq(rules.createdBy, auth.memberId),
          ),
        )
        .returning({ id: rules.id });
      if (deleted.length === 0) throw new HttpError(404, 'not_found', 'Rule not found');
      return reply.code(204).send(null);
    },
  );

  r.get(
    '/transactions',
    {
      config: { access: 'member' },
      schema: {
        tags: ['transactions'],
        security,
        querystring: listTransactionsQuery,
        response: { 200: listTransactionsResponse, '4xx': errorResponse },
      },
    },
    async (req) => {
      const auth = authOf(req);
      const { db, keyring } = app.ctx;
      const visible = await visibleAccountIds(db, auth);
      const dk = await keyring.forHousehold(auth.householdId);
      const { limit, ...filters } = req.query;
      const page = await queryTransactions(db, dk, visible, { ...filters, limit });
      const splits = await listSplits(
        db,
        dk,
        visible,
        page.items.map((t) => t.id),
      );
      return {
        transactions: page.items.map((t) => toInfo(t, splits)),
        nextCursor: page.nextCursor,
        scannedUntil: page.scannedUntil,
      };
    },
  );

  r.patch(
    '/transactions/:id',
    {
      config: { access: 'member' },
      schema: {
        tags: ['transactions'],
        security,
        params: transactionIdParams,
        body: patchTransactionRequest,
        response: { 200: patchTransactionResponse, '4xx': errorResponse },
      },
    },
    async (req) => {
      const auth = authOf(req);
      const { db, keyring } = app.ctx;
      const visible = await visibleAccountIds(db, auth);
      const dk = await keyring.forHousehold(auth.householdId);
      const tx = await loadVisible(db, dk, visible, req.params.id);
      const { categoryId, applyToCounterparty } = req.body;
      await requireCategories(db, auth.householdId, [categoryId]);

      let match: { counterpartyIban: string } | { counterpartyContains: string } | null = null;
      if (applyToCounterparty) {
        const name = tx.counterparty?.trim();
        match = tx.counterpartyIban
          ? { counterpartyIban: tx.counterpartyIban }
          : name
            ? { counterpartyContains: name }
            : null;
        if (!match) {
          throw new HttpError(422, 'no_counterparty', 'Transaction has no counterparty to match');
        }
      }

      let recategorized = 0;
      await setCategory(db, tx.id, categoryId, 'manual');
      if (match) {
        await createRule(db, dk, {
          householdId: auth.householdId,
          createdBy: auth.memberId,
          match,
          categoryId,
        });
        if (tx.counterpartyBidx !== null) {
          const changed = await recategorizeCounterparty(
            db,
            dk,
            auth.householdId,
            tx.counterpartyBidx,
          );
          // R15: the rule is household-wide, but the count only covers what the caller may see.
          recategorized = changed.filter((c) => visible.includes(c.accountId)).length;
        }
      }
      const updated = await loadVisible(db, dk, visible, tx.id);
      const splits = await listSplits(db, dk, visible, [tx.id]);
      return { transaction: toInfo(updated, splits), recategorized };
    },
  );

  r.post(
    '/transactions/:id/splits',
    {
      config: { access: 'member' },
      schema: {
        tags: ['transactions'],
        security,
        params: transactionIdParams,
        body: splitsRequest,
        response: { 200: splitsResponse, '4xx': errorResponse },
      },
    },
    async (req) => {
      const auth = authOf(req);
      const { db, keyring } = app.ctx;
      const visible = await visibleAccountIds(db, auth);
      const dk = await keyring.forHousehold(auth.householdId);
      const tx = await loadVisible(db, dk, visible, req.params.id);
      const parts = req.body.parts.map((p) => ({
        categoryId: p.categoryId,
        currency: p.amount.currency,
        amountMinor: BigInt(p.amount.minor),
      }));
      const txNegative = tx.amountMinor < 0n;
      const total = parts.reduce((acc, p) => acc + p.amountMinor, 0n);
      if (
        total !== tx.amountMinor ||
        parts.some((p) => p.currency !== tx.currency || p.amountMinor === 0n) ||
        parts.some((p) => p.amountMinor < 0n !== txNegative)
      ) {
        throw new HttpError(
          422,
          'splits_mismatch',
          'Split amounts must share the transaction sign and currency and sum to its amount',
        );
      }
      await requireCategories(
        db,
        auth.householdId,
        parts.map((p) => p.categoryId),
      );
      await replaceSplits(db, dk, visible, tx.id, parts);
      const splits = await listSplits(db, dk, visible, [tx.id]);
      return { transaction: toInfo(tx, splits) };
    },
  );
}

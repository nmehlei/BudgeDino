import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  errorResponse,
  listTransactionsQuery,
  listTransactionsResponse,
  patchTransactionRequest,
  patchTransactionResponse,
  splitsRequest,
  splitsResponse,
  transactionIdParams,
  type TransactionInfo,
} from '@budgedino/shared';
import { visibleAccountIds, type VisibleAccountIds } from '../access/visibility.js';
import type { Db } from '../db/client.js';
import { categories } from '../db/schema.js';
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
import { createRule, recategorizeCounterparty, setCategory } from './rules.js';

const notFound = () => new HttpError(404, 'not_found', 'Transaction not found');
const unknownCategory = () => new HttpError(422, 'unknown_category', 'Category not found');

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

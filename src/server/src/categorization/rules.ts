import { and, desc, eq, inArray, isNotNull, isNull, max, sql } from 'drizzle-orm';
import { decryptString, encryptField, type DataKey } from '../crypto/index.js';
import type { Db } from '../db/client.js';
import { newId } from '../db/ids.js';
import { accounts, categories, connectors, rules, transactions } from '../db/schema.js';
import type { Keyring } from '../households/keyring.js';
import { toTransaction, type Transaction } from '../repositories/transactions.js';
import {
  buildHeuristics,
  categorize,
  type CategorizeContext,
  type CategorySource,
  type Rule,
  type RuleMatch,
} from './engine.js';

const ruleAad = (rowId: string) => ({ table: 'rules', column: 'match', rowId });

/**
 * Household-wide transaction rows for categorization and transfer detection. These are server-internal
 * jobs: rules, learned matches and transfer pairs apply to every account of the household, including
 * other members' `owner_only` accounts (budgets may count them), so they deliberately do not go through
 * the per-caller visibility gate. Nothing read here is returned to a caller without it.
 */
export function householdTransactionRows(db: Db, householdId: string) {
  return db
    .select({ tx: transactions, accountId: accounts.id })
    .from(transactions)
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .innerJoin(connectors, eq(accounts.connectorId, connectors.id))
    .where(eq(connectors.householdId, householdId))
    .$dynamic();
}

export async function loadRules(db: Db, dk: DataKey, householdId: string): Promise<Rule[]> {
  const rows = await db.select().from(rules).where(eq(rules.householdId, householdId));
  return rows.map((r) => ({
    id: r.id,
    priority: r.priority,
    createdAt: r.createdAt,
    match: JSON.parse(decryptString(dk, r.matchEnc, ruleAad(r.id))) as RuleMatch,
    categoryId: r.categoryId,
  }));
}

/** Creates a household rule with a priority above every existing one. */
export async function createRule(
  db: Db,
  dk: DataKey,
  input: { householdId: string; createdBy: string; match: RuleMatch; categoryId: string },
): Promise<Rule> {
  const id = newId();
  const [top] = await db
    .select({ p: max(rules.priority) })
    .from(rules)
    .where(eq(rules.householdId, input.householdId));
  const priority = (top?.p ?? 0) + 1;
  const [row] = await db
    .insert(rules)
    .values({
      id,
      householdId: input.householdId,
      priority,
      matchEnc: encryptField(dk, JSON.stringify(input.match), ruleAad(id)),
      categoryId: input.categoryId,
      createdBy: input.createdBy,
    })
    .returning();
  if (!row) throw new Error('rule insert returned no row');
  return {
    id,
    priority,
    createdAt: row.createdAt,
    match: input.match,
    categoryId: input.categoryId,
  };
}

/** counterparty_bidx -> category of the most recent `manual` categorization in the household. */
export async function loadLearned(db: Db, householdId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ bidx: transactions.counterpartyBidx, categoryId: transactions.categoryId })
    .from(transactions)
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .innerJoin(connectors, eq(accounts.connectorId, connectors.id))
    .where(
      and(
        eq(connectors.householdId, householdId),
        eq(transactions.categorySource, 'manual'),
        isNotNull(transactions.counterpartyBidx),
        isNotNull(transactions.categoryId),
      ),
    )
    .orderBy(sql`${transactions.categorySetAt} desc nulls last`, desc(transactions.id));
  const learned = new Map<string, string>();
  for (const r of rows) {
    if (r.bidx !== null && r.categoryId !== null && !learned.has(r.bidx)) {
      learned.set(r.bidx, r.categoryId);
    }
  }
  return learned;
}

export async function loadCategoryRows(db: Db, householdId: string) {
  return db.select().from(categories).where(eq(categories.householdId, householdId));
}

export async function buildContext(
  db: Db,
  dk: DataKey,
  householdId: string,
): Promise<CategorizeContext> {
  const [ruleList, learned, cats] = await Promise.all([
    loadRules(db, dk, householdId),
    loadLearned(db, householdId),
    loadCategoryRows(db, householdId),
  ]);
  return { rules: ruleList, learned, heuristics: buildHeuristics(cats) };
}

export async function setCategory(
  db: Db,
  id: string,
  categoryId: string | null,
  source: CategorySource,
): Promise<void> {
  await db
    .update(transactions)
    .set({ categoryId, categorySource: source, categorySetAt: new Date() })
    .where(eq(transactions.id, id));
}

interface Candidate {
  accountId: string;
  tx: Transaction;
}

/**
 * Categorizes `candidates` (never `manual` ones or transfer-group members); returns the ones changed.
 * A row keeps its existing category when nothing matches any more (a booked update of a pending row
 * keeps what it had); only rows without a category end up `none`.
 */
async function apply(
  db: Db,
  ctx: CategorizeContext,
  candidates: readonly Candidate[],
): Promise<Candidate[]> {
  const changed: Candidate[] = [];
  for (const c of candidates) {
    const { tx } = c;
    if (tx.categorySource === 'manual' || tx.transferGroupId !== null) continue;
    const result = categorize(tx, ctx);
    if (result.categoryId === null && tx.categoryId !== null) continue;
    if (result.categoryId === tx.categoryId && result.source === tx.categorySource) continue;
    await setCategory(db, tx.id, result.categoryId, result.source);
    changed.push(c);
  }
  return changed;
}

/** The `onIngested` step: categorizes freshly inserted/updated transactions of a household. */
export async function categorizeTransactions(
  db: Db,
  keyring: Keyring,
  householdId: string,
  txIds: readonly string[],
): Promise<void> {
  if (txIds.length === 0) return;
  const dk = await keyring.forHousehold(householdId);
  const rows = await householdTransactionRows(db, householdId).where(
    and(eq(connectors.householdId, householdId), inArray(transactions.id, [...txIds])),
  );
  const ctx = await buildContext(db, dk, householdId);
  await apply(
    db,
    ctx,
    rows.map((r) => ({ accountId: r.accountId, tx: toTransaction(dk, r.tx) })),
  );
}

/**
 * Re-runs categorization over the household's non-manual history of one counterparty (after a rule was
 * created). Household-wide per R15; returns the changed rows' account ids so the caller can count only
 * what its member may see.
 */
export async function recategorizeCounterparty(
  db: Db,
  dk: DataKey,
  householdId: string,
  counterpartyBidx: string,
): Promise<{ id: string; accountId: string }[]> {
  const rows = await householdTransactionRows(db, householdId).where(
    and(
      eq(connectors.householdId, householdId),
      eq(transactions.counterpartyBidx, counterpartyBidx),
      isNull(transactions.transferGroupId),
    ),
  );
  const ctx = await buildContext(db, dk, householdId);
  const changed = await apply(
    db,
    ctx,
    rows.map((r) => ({ accountId: r.accountId, tx: toTransaction(dk, r.tx) })),
  );
  return changed.map((c) => ({ id: c.tx.id, accountId: c.accountId }));
}

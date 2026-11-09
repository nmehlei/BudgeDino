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
    .select({
      tx: transactions,
      accountId: accounts.id,
      ownerMemberId: accounts.ownerMemberId,
      visibility: accounts.visibility,
      countsTowardBudgets: accounts.countsTowardBudgets,
    })
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
    createdBy: r.createdBy,
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
    createdBy: input.createdBy,
  };
}

/** counterparty_bidx -> category of the most recent `manual` categorization in the household. */
export async function loadLearned(
  db: Db,
  householdId: string,
): Promise<{ learned: Map<string, string>; owners: Map<string, string> }> {
  const rows = await db
    .select({
      bidx: transactions.counterpartyBidx,
      categoryId: transactions.categoryId,
      owner: accounts.ownerMemberId,
    })
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
  const owners = new Map<string, string>();
  for (const r of rows) {
    if (r.bidx !== null && r.categoryId !== null && !learned.has(r.bidx)) {
      learned.set(r.bidx, r.categoryId);
      owners.set(r.bidx, r.owner);
    }
  }
  return { learned, owners };
}

export async function loadCategoryRows(db: Db, householdId: string) {
  return db.select().from(categories).where(eq(categories.householdId, householdId));
}

export interface ScopedContext extends CategorizeContext {
  /** counterparty_bidx -> owner of the account the learned manual categorization was made on. */
  learnedOwners: ReadonlyMap<string, string>;
}

export async function buildContext(
  db: Db,
  dk: DataKey,
  householdId: string,
): Promise<ScopedContext> {
  const [ruleList, learned, cats] = await Promise.all([
    loadRules(db, dk, householdId),
    loadLearned(db, householdId),
    loadCategoryRows(db, householdId),
  ]);
  return {
    rules: ruleList,
    learned: learned.learned,
    learnedOwners: learned.owners,
    heuristics: buildHeuristics(cats),
  };
}

/** The target account facts R18 needs. */
interface AccountScope {
  ownerMemberId: string;
  visibility: 'household' | 'owner_only';
  countsTowardBudgets: boolean;
}

/**
 * R18: a rule (or learned match, treated as a rule of the member who owns the account it was learned on)
 * only affects accounts its creator can see (`household`, or owned by the creator) or that count toward
 * budgets (budget consistency).
 */
function allowed(creator: string | null | undefined, scope: AccountScope): boolean {
  return (
    scope.visibility === 'household' ||
    scope.countsTowardBudgets ||
    (creator != null && scope.ownerMemberId === creator)
  );
}

function scopedFor(ctx: ScopedContext, scope: AccountScope): CategorizeContext {
  const learned = new Map<string, string>();
  for (const [bidx, categoryId] of ctx.learned) {
    if (allowed(ctx.learnedOwners.get(bidx), scope)) learned.set(bidx, categoryId);
  }
  return {
    rules: ctx.rules.filter((r) => allowed(r.createdBy, scope)),
    learned,
    heuristics: ctx.heuristics,
  };
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
  scope: AccountScope;
  tx: Transaction;
}

/**
 * Categorizes `candidates` (never `manual` ones or transfer-group members); returns the ones changed.
 * With `onlyUncategorized` (ingest, R16) rows that already have a category keep it, e.g. a booked update
 * of a pending row; explicit recategorization (rule creation) passes false. A row never loses a category
 * because nothing matches any more.
 */
async function apply(
  db: Db,
  ctx: ScopedContext,
  candidates: readonly Candidate[],
  onlyUncategorized: boolean,
): Promise<Candidate[]> {
  const changed: Candidate[] = [];
  const perAccount = new Map<string, CategorizeContext>();
  for (const c of candidates) {
    const { tx } = c;
    if (tx.categorySource === 'manual' || tx.transferGroupId !== null) continue;
    // R16: ingest only categorizes new rows and rows without a category; updates keep theirs.
    if (onlyUncategorized && tx.categorySource !== 'none' && tx.categoryId !== null) continue;
    let scoped = perAccount.get(c.accountId);
    if (!scoped) {
      scoped = scopedFor(ctx, c.scope);
      perAccount.set(c.accountId, scoped);
    }
    const result = categorize(tx, scoped);
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
    rows.map((r) => ({
      accountId: r.accountId,
      scope: {
        ownerMemberId: r.ownerMemberId,
        visibility: r.visibility,
        countsTowardBudgets: r.countsTowardBudgets,
      },
      tx: toTransaction(dk, r.tx),
    })),
    true,
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
    rows.map((r) => ({
      accountId: r.accountId,
      scope: {
        ownerMemberId: r.ownerMemberId,
        visibility: r.visibility,
        countsTowardBudgets: r.countsTowardBudgets,
      },
      tx: toTransaction(dk, r.tx),
    })),
    false,
  );
  return changed.map((c) => ({ id: c.tx.id, accountId: c.accountId }));
}

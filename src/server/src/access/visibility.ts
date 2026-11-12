import { and, eq, or } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { accounts } from '../db/schema.js';
import type { AuthContext } from '../deps.js';

declare const visibleBrand: unique symbol;

/**
 * Account ids the caller may see. Only `visibleAccountIds` can create one, and every repository
 * read of accounts, transactions, splits and balances requires it, so a read cannot be written
 * without going through the visibility gate.
 */
export type VisibleAccountIds = readonly string[] & { readonly [visibleBrand]: true };

/**
 * The single visibility gate: accounts of the caller's household that are `household`-visible, plus
 * every account the caller owns. `owner_only` accounts of other members are excluded for everyone,
 * admins included.
 */
export async function visibleAccountIds(
  db: Db,
  ctx: Pick<AuthContext, 'memberId' | 'householdId'>,
): Promise<VisibleAccountIds> {
  const rows = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      and(
        eq(accounts.householdId, ctx.householdId),
        or(eq(accounts.visibility, 'household'), eq(accounts.ownerMemberId, ctx.memberId)),
      ),
    );
  return rows.map((r) => r.id) as unknown as VisibleAccountIds;
}

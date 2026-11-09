import { and, eq, gt, isNull, ne, notInArray, or, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { syncRuns } from '../db/schema.js';

const WINDOW_MS = 24 * 60 * 60 * 1000;
/** Outcomes of runs that never reached the bank. */
const NO_BANK_CONTACT = ['rate_limited', 'skipped'];

/**
 * Unattended (`trigger='schedule'`) runs of a connector in the rolling 24 h before `now`, excluding
 * `excludeRunId` (the run being decided) and runs that never reached the bank (`rate_limited`, `skipped`).
 */
export async function countUnattendedRuns(
  db: DbOrTx,
  connectorId: string,
  now: Date,
  excludeRunId: string,
): Promise<number> {
  const since = new Date(now.getTime() - WINDOW_MS);
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(syncRuns)
    .where(
      and(
        eq(syncRuns.connectorId, connectorId),
        eq(syncRuns.trigger, 'schedule'),
        gt(syncRuns.startedAt, since),
        ne(syncRuns.id, excludeRunId),
        or(isNull(syncRuns.outcome), notInArray(syncRuns.outcome, NO_BANK_CONTACT)),
      ),
    );
  return row?.n ?? 0;
}

/** True when another unattended run would exceed `maxUnattendedPerDay` (null = uncapped). */
export async function isUnattendedBudgetExhausted(
  db: DbOrTx,
  connectorId: string,
  now: Date,
  excludeRunId: string,
  maxUnattendedPerDay: number | null,
): Promise<boolean> {
  if (maxUnattendedPerDay === null) return false;
  return (await countUnattendedRuns(db, connectorId, now, excludeRunId)) >= maxUnattendedPerDay;
}

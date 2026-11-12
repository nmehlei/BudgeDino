import { and, eq, isNull } from 'drizzle-orm';
import { periodFor } from '@budgedino/shared';
import { encryptField } from '../crypto/index.js';
import type { Db } from '../db/client.js';
import { newId } from '../db/ids.js';
import { members, notifications } from '../db/schema.js';
import { createFxConverter } from '../fx/service.js';
import type { Keyring } from '../households/keyring.js';
import { householdSettings, listBudgets, spentFor } from './service.js';

/** Usage thresholds (percent of the budget amount) that notify the household. */
export const ALERT_THRESHOLDS = [80, 100] as const;
export const BUDGET_THRESHOLD_KIND = 'budget_threshold';

/**
 * Creates the threshold notifications for the household's budgets in the current period: one per member,
 * per budget, per threshold, per period key. The unique `(member_id, dedup_key)` index makes every
 * insert idempotent, so re-evaluating after each ingest never duplicates, and a dip below a threshold
 * followed by another crossing in the same period does not notify again.
 *
 * The body is `"<budget name> reached <n>%"`: budget names are plaintext by design and no amounts or
 * transaction details are included, so nothing from an `owner_only` account can leak through it.
 */
export async function evaluateAlerts(
  db: Db,
  keyring: Keyring,
  householdId: string,
  now: Date,
): Promise<number> {
  const dk = await keyring.forHousehold(householdId);
  const settings = await householdSettings(db, householdId);
  const list = await listBudgets(db, dk, householdId);
  if (list.length === 0) return 0;
  const recipients = await db
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.householdId, householdId), isNull(members.disabledAt)));
  const fx = createFxConverter(db);
  let created = 0;
  for (const budget of list) {
    const period = periodFor(now, budget.periodKind, settings.timezone);
    const { spent } = await spentFor(db, dk, budget, period, settings, fx);
    for (const threshold of ALERT_THRESHOLDS) {
      if (spent.minor * 100n < budget.amount.minor * BigInt(threshold)) continue;
      for (const member of recipients) {
        const id = newId();
        const inserted = await db
          .insert(notifications)
          .values({
            id,
            householdId,
            memberId: member.id,
            kind: BUDGET_THRESHOLD_KIND,
            bodyEnc: encryptField(dk, `${budget.name} reached ${threshold}%`, {
              table: 'notifications',
              column: 'body',
              rowId: id,
            }),
            dedupKey: `budget:${budget.id}:${period.key}:${threshold}`,
          })
          .onConflictDoNothing()
          .returning({ id: notifications.id });
        created += inserted.length;
      }
    }
  }
  return created;
}

import { z } from 'zod';
import { connectorInfo } from './connectors';

const moneyJson = z.object({ minor: z.string(), currency: z.string() });
/** Request-side money: amounts are validated semantically (positive, base currency) with 422 by the route. */
const moneyInput = z.object({
  minor: z.string().regex(/^-?\d{1,15}$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
});

export const periodKind = z.enum(['weekly', 'monthly']);

export const periodView = z.object({
  key: z.string(),
  /** Inclusive instant of the period start (household time zone midnight). */
  start: z.iso.datetime(),
  /** Exclusive instant. */
  end: z.iso.datetime(),
});
export type PeriodView = z.infer<typeof periodView>;

export const budgetView = z.object({
  id: z.string(),
  name: z.string(),
  categoryIds: z.array(z.string()),
  periodKind,
  amount: moneyJson,
  /** Raw spent in the budget currency: refunds reduce it, so it may be negative. */
  spent: moneyJson,
  /** `max(0, spent) / amount`, four decimals as a string. */
  ratio: z.string(),
  /** True when a foreign-currency transaction had no FX rate and was left out of `spent`. */
  fxMissing: z.boolean(),
  period: periodView,
});
export type BudgetView = z.infer<typeof budgetView>;

export const budgetIdParams = z.object({ id: z.uuid() });

const budgetName = z.string().trim().min(1).max(80);
const categoryIds = z.array(z.uuid()).min(1).max(50);

export const createBudgetRequest = z
  .object({ name: budgetName, categoryIds, periodKind, amount: moneyInput })
  .strict();
export type CreateBudgetRequest = z.infer<typeof createBudgetRequest>;

export const patchBudgetRequest = z
  .object({
    name: budgetName.optional(),
    categoryIds: categoryIds.optional(),
    periodKind: periodKind.optional(),
    amount: moneyInput.optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'At least one field is required' });
export type PatchBudgetRequest = z.infer<typeof patchBudgetRequest>;

export const budgetResponse = z.object({ budget: budgetView });
export const budgetListResponse = z.object({ budgets: z.array(budgetView) });
export const budgetArchivedResponse = z.object({ id: z.string(), archived: z.literal(true) });

/** `current` | `previous` | `2026-11` (month) | `2026-W46` (ISO week). */
export const homeQuery = z.object({
  period: z
    .string()
    .regex(/^(current|previous|\d{4}-(0[1-9]|1[0-2])|\d{4}-W(0[1-9]|[1-4]\d|5[0-3]))$/)
    .default('current'),
});
export type HomeQuery = z.infer<typeof homeQuery>;

export const homeResponse = z.object({
  period: periodView.extend({ kind: periodKind }),
  budgets: z.array(budgetView),
  /** Spending per category over the viewer's visible accounts, largest first. */
  breakdown: z.array(
    z.object({ categoryId: z.string().nullable(), name: z.string(), spent: moneyJson }),
  ),
  /** Income over the viewer's visible accounts; refunds are not income. */
  income: moneyJson,
  /** Positive amounts without a category; excluded from the breakdown. */
  uncategorizedIncome: moneyJson,
  fxMissing: z.boolean(),
  sync: z.array(connectorInfo),
});
export type HomeResponse = z.infer<typeof homeResponse>;

export const MAX_NOTIFICATION_PAGE = 100;

export const notificationsQuery = z.object({
  since: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\|[0-9a-f-]{36}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(MAX_NOTIFICATION_PAGE).default(MAX_NOTIFICATION_PAGE),
});

export const notificationsResponse = z.object({
  notifications: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      body: z.string().nullable(),
      createdAt: z.iso.datetime(),
    }),
  ),
  /** Pass as `since` on the next poll; unchanged when nothing new arrived. */
  nextCursor: z.string().nullable(),
});
export type NotificationsResponse = z.infer<typeof notificationsResponse>;

export const ackNotificationsRequest = z
  .object({ ids: z.array(z.uuid()).min(1).max(MAX_NOTIFICATION_PAGE) })
  .strict();
export const ackNotificationsResponse = z.object({ acked: z.number().int().nonnegative() });

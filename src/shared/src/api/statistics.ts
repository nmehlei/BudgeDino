import { z } from 'zod';

const moneyJson = z.object({ minor: z.string(), currency: z.string() });

/** `months`: window length, 6 (default) or 12. */
export const statisticsQuery = z.object({
  months: z.coerce
    .number()
    .pipe(z.union([z.literal(6), z.literal(12)]))
    .default(6),
});
export type StatisticsQuery = z.infer<typeof statisticsQuery>;

export const statisticsResponse = z.object({
  /** Oldest first; months before the viewer's first visible transaction are omitted. */
  months: z.array(
    z.object({
      key: z.string().regex(/^\d{4}-\d{2}$/),
      start: z.string(),
      end: z.string(),
      /** True for the current (unfinished) month. */
      partial: z.boolean(),
      /** Income categories plus uncategorized positive amounts. */
      income: moneyJson,
      spending: moneyJson,
    }),
  ),
  /** Mean of income minus spending over the complete months of `months`; null when there are none. */
  averageKept: moneyJson.nullable(),
  /** Net spend per category over the window and the equally long window before it; largest first. */
  categories: z.array(
    z.object({
      categoryId: z.string().nullable(),
      name: z.string(),
      icon: z.string().nullable(),
      color: z.string().nullable(),
      spent: moneyJson,
      previousSpent: moneyJson,
    }),
  ),
  fxMissing: z.boolean(),
});
export type StatisticsResponse = z.infer<typeof statisticsResponse>;

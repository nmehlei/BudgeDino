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
      /** True for the current (unfinished) month and for the first booking's month unless booked on the 1st. */
      partial: z.boolean(),
      /** Income categories plus uncategorized positive amounts. */
      income: moneyJson,
      spending: moneyJson,
    }),
  ),
  /** Mean of income minus spending over the complete months of `months`; null when there are none. */
  averageKept: moneyJson.nullable(),
  /** Net spend per category over the window plus the trend basis; largest first. */
  categories: z.array(
    z.object({
      categoryId: z.string().nullable(),
      name: z.string(),
      icon: z.string().nullable().default(null),
      color: z.string().nullable().default(null),
      /** Net spend over the window, including the current (partial) month. */
      spent: moneyJson,
      /** Net spend over the window's complete months only (what the trend compares). */
      trendSpent: moneyJson,
      /** The same number of complete months before them; null when that history is incomplete (no trend). */
      previousSpent: moneyJson.nullable(),
    }),
  ),
  fxMissing: z.boolean(),
});
export type StatisticsResponse = z.infer<typeof statisticsResponse>;

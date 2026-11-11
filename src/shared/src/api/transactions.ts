import { z } from 'zod';

export const categorySource = z.enum(['rule', 'learned', 'heuristic', 'manual', 'none']);
export type CategorySourceName = z.infer<typeof categorySource>;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** Signed integer minor units as a decimal string. */
const minorString = z.string().regex(/^-?\d{1,18}$/);

export const splitInfo = z.object({
  id: z.string(),
  categoryId: z.string().nullable(),
  amountMinor: minorString,
});

/** Only ever returned for accounts the caller may see. */
export const transactionInfo = z.object({
  id: z.string(),
  accountId: z.string(),
  status: z.enum(['pending', 'booked']),
  bookingDate: isoDate,
  valueDate: isoDate.nullable(),
  amountMinor: minorString,
  currency: z.string(),
  counterparty: z.string().nullable(),
  purpose: z.string().nullable(),
  categoryId: z.string().nullable(),
  categorySource,
  transferGroupId: z.string().nullable(),
  splits: z.array(splitInfo),
});
export type TransactionInfo = z.infer<typeof transactionInfo>;

export const transactionIdParams = z.object({ id: z.uuid() });

export const MAX_TRANSACTION_PAGE = 200;

export const listTransactionsQuery = z
  .object({
    from: isoDate.optional(),
    to: isoDate.optional(),
    accountId: z.uuid().optional(),
    categoryId: z.uuid().optional(),
    /** `true` or `1`: only transactions without a category; mutually exclusive with `categoryId`. */
    uncategorized: z
      .enum(['true', '1'])
      .transform(() => true as const)
      .optional(),
    /** Case-insensitive substring of counterparty or purpose; trimmed, 2-64 characters. */
    q: z.string().trim().min(2).max(64).optional(),
    cursor: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}\|[0-9a-f-]{36}$/)
      .optional(),
    limit: z.coerce.number().int().min(1).max(MAX_TRANSACTION_PAGE).default(50),
  })
  .refine((v) => !(v.uncategorized === true && v.categoryId !== undefined), {
    message: 'uncategorized and categoryId are mutually exclusive',
  });
export type ListTransactionsQuery = z.infer<typeof listTransactionsQuery>;

export const listTransactionsResponse = z.object({
  transactions: z.array(transactionInfo),
  nextCursor: z.string().nullable(),
  /** Search only: booking date of the last scanned row when the scan stopped early; null otherwise. */
  scannedUntil: isoDate.nullable(),
});
export type ListTransactionsResponse = z.infer<typeof listTransactionsResponse>;

export const patchTransactionRequest = z
  .object({
    categoryId: z.uuid(),
    applyToCounterparty: z.boolean().optional(),
  })
  .strict();
export type PatchTransactionRequest = z.infer<typeof patchTransactionRequest>;

export const patchTransactionResponse = z.object({
  transaction: transactionInfo,
  /** Past transactions of the counterparty recategorized by the new rule, counting only ones the caller can see. */
  recategorized: z.number().int().nonnegative(),
});
export type PatchTransactionResponse = z.infer<typeof patchTransactionResponse>;

export const splitsRequest = z
  .object({
    parts: z
      .array(
        z.object({
          categoryId: z.uuid(),
          amount: z.object({ minor: minorString, currency: z.string().regex(/^[A-Z]{3}$/) }),
        }),
      )
      .min(1)
      .max(50),
  })
  .strict();
export type SplitsRequest = z.infer<typeof splitsRequest>;

export const splitsResponse = z.object({ transaction: transactionInfo });
export type SplitsResponse = z.infer<typeof splitsResponse>;

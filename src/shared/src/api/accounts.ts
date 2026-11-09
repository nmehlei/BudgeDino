import { z } from 'zod';

export const accountVisibility = z.enum(['household', 'owner_only']);
export type AccountVisibility = z.infer<typeof accountVisibility>;

export const accountKind = z.enum(['checking', 'savings', 'credit_card', 'depot', 'other']);

/** Only ever returned to members allowed to see the account; `ibanMasked` shows the last 4 characters. */
export const accountInfo = z.object({
  id: z.string(),
  connectorId: z.string(),
  ownerMemberId: z.string(),
  name: z.string(),
  ibanMasked: z.string().nullable(),
  kind: accountKind,
  currency: z.string(),
  visibility: accountVisibility,
  countsTowardBudgets: z.boolean(),
  /** Signed integer minor units as a decimal string. */
  balanceMinor: z.string().nullable(),
  isOwner: z.boolean(),
});
export type AccountInfo = z.infer<typeof accountInfo>;

export const accountListResponse = z.object({ accounts: z.array(accountInfo) });
export type AccountListResponse = z.infer<typeof accountListResponse>;

export const accountIdParams = z.object({ id: z.uuid() });

/**
 * Changing `visibility` to `owner_only` also sets `countsTowardBudgets=false` unless the request
 * passes `countsTowardBudgets` explicitly.
 */
export const updateAccountRequest = z
  .object({
    visibility: accountVisibility.optional(),
    countsTowardBudgets: z.boolean().optional(),
  })
  .strict()
  .refine((v) => v.visibility !== undefined || v.countsTowardBudgets !== undefined, {
    message: 'at least one field is required',
  });
export type UpdateAccountRequest = z.infer<typeof updateAccountRequest>;

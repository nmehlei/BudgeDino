import { z } from 'zod';
import { accountKind } from './accounts';

const moneyJson = z.object({ minor: z.string(), currency: z.string() });

export const netWorthAccount = z.object({
  id: z.string(),
  name: z.string(),
  kind: accountKind,
  isOwner: z.boolean(),
  /** The connection was removed with "keep history"; the balance is the last known one. */
  disconnected: z.boolean(),
  /** Latest balance reported by a sync; null when the account never reported one (excluded from totals). */
  balance: moneyJson.nullable(),
  /** `balance` in the household base currency; null without a balance or without an FX rate. */
  baseBalance: moneyJson.nullable(),
  balanceAt: z.iso.datetime().nullable(),
});
export type NetWorthAccount = z.infer<typeof netWorthAccount>;

export const netWorthGroup = z.object({
  kind: accountKind,
  /** Sum of the converted balances of the group, in the base currency. */
  total: moneyJson,
  fxMissing: z.boolean(),
  accounts: z.array(netWorthAccount),
});
export type NetWorthGroup = z.infer<typeof netWorthGroup>;

export const netWorthResponse = z.object({
  baseCurrency: z.string(),
  total: moneyJson,
  /** Some account could not be converted (no ECB rate) and is left out of the totals. */
  fxMissing: z.boolean(),
  groups: z.array(netWorthGroup),
});
export type NetWorthResponse = z.infer<typeof netWorthResponse>;

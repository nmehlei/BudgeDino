import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  errorResponse,
  money,
  netWorthResponse,
  sum,
  toJSON,
  type Money,
  type NetWorthAccount,
  type NetWorthGroup,
  type NetWorthResponse,
} from '@budgedino/shared';
import { visibleAccountIds } from '../access/visibility.js';
import { householdSettings } from '../budgets/service.js';
import type { Db } from '../db/client.js';
import type { AuthContext } from '../deps.js';
import { createFxConverter, FxRateMissingError } from '../fx/service.js';
import type { Keyring } from '../households/keyring.js';
import { listAccounts } from '../repositories/accounts.js';

/** Display order of the groups; kinds without accounts are omitted. */
const KIND_ORDER = ['checking', 'savings', 'credit_card', 'depot', 'other'] as const;

/**
 * Current net worth over the accounts the caller may see (`visibleAccountIds`): latest synced balance per
 * account, converted to the household base currency with the ECB rate of today (or the latest earlier one).
 * Accounts without a balance are listed but excluded; accounts without an FX rate are excluded and flagged.
 */
export async function computeNetWorth(
  db: Db,
  keyring: Keyring,
  auth: Pick<AuthContext, 'memberId' | 'householdId'>,
  now: Date,
): Promise<NetWorthResponse> {
  const visible = await visibleAccountIds(db, auth);
  const dk = await keyring.forHousehold(auth.householdId);
  const settings = await householdSettings(db, auth.householdId);
  const base = settings.baseCurrency;
  const fx = createFxConverter(db);
  const on = now.toISOString().slice(0, 10);
  const rows = (await listAccounts(db, dk, visible)).sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );

  const groups: NetWorthGroup[] = [];
  const converted: Money[] = [];
  let fxMissing = false;
  for (const kind of KIND_ORDER) {
    const accounts: NetWorthAccount[] = [];
    const inGroup: Money[] = [];
    let groupFxMissing = false;
    for (const a of rows.filter((r) => r.kind === kind)) {
      const balance = a.balanceMinor === null ? null : money(a.balanceMinor, a.currency);
      let baseBalance: Money | null = null;
      if (balance !== null) {
        try {
          baseBalance = await fx.convert(balance, on, base);
          inGroup.push(baseBalance);
        } catch (err) {
          if (!(err instanceof FxRateMissingError)) throw err;
          groupFxMissing = true;
        }
      }
      accounts.push({
        id: a.id,
        name: a.name,
        kind: a.kind,
        isOwner: a.ownerMemberId === auth.memberId,
        disconnected: a.disconnected,
        balance: balance === null ? null : toJSON(balance),
        baseBalance: baseBalance === null ? null : toJSON(baseBalance),
        balanceAt: a.balanceAt === null ? null : a.balanceAt.toISOString(),
      });
    }
    if (accounts.length === 0) continue;
    converted.push(...inGroup);
    fxMissing ||= groupFxMissing;
    groups.push({
      kind,
      total: toJSON(sum(inGroup, base)),
      fxMissing: groupFxMissing,
      accounts,
    });
  }
  return { baseCurrency: base, total: toJSON(sum(converted, base)), fxMissing, groups };
}

export function netWorthRoutes(app: FastifyInstance): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/net-worth',
    {
      config: { access: 'member' },
      schema: {
        tags: ['net-worth'],
        security: [{ bearer: [] }],
        response: { 200: netWorthResponse, '4xx': errorResponse },
      },
    },
    async (req) => {
      const auth = req.auth;
      if (!auth) throw new Error('unreachable: the access hook authenticates');
      const { db, keyring, now } = app.ctx;
      return computeNetWorth(db, keyring, auth, now());
    },
  );
}

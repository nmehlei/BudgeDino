import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  accountIdParams,
  accountInfo,
  accountListResponse,
  errorResponse,
  updateAccountRequest,
  type AccountInfo,
} from '@budgedino/shared';
import { visibleAccountIds } from '../access/visibility.js';
import type { AuthContext } from '../deps.js';
import { HttpError } from '../http/errors.js';
import { listAccounts, updateOwnAccount, type Account } from '../repositories/accounts.js';

const MASK_PREFIX = '•••• ';
const IBAN_VISIBLE_TAIL = 4;

/** Masked IBAN: bullets plus the last 4 characters, e.g. `•••• 3000`. */
export function maskIban(iban: string): string {
  const compact = iban.replaceAll(/\s+/g, '');
  return `${MASK_PREFIX}${compact.slice(-IBAN_VISIBLE_TAIL)}`;
}

function toInfo(account: Account, auth: AuthContext): AccountInfo {
  return {
    id: account.id,
    connectorId: account.connectorId,
    ownerMemberId: account.ownerMemberId,
    name: account.name,
    ibanMasked: account.iban === null ? null : maskIban(account.iban),
    kind: account.kind,
    currency: account.currency,
    visibility: account.visibility,
    countsTowardBudgets: account.countsTowardBudgets,
    balanceMinor: account.balanceMinor === null ? null : account.balanceMinor.toString(),
    isOwner: account.ownerMemberId === auth.memberId,
  };
}

export function accountRoutes(app: FastifyInstance): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const security = [{ bearer: [] }];

  r.get(
    '/accounts',
    {
      config: { access: 'member' },
      schema: {
        tags: ['accounts'],
        security,
        response: { 200: accountListResponse, '4xx': errorResponse },
      },
    },
    async (req) => {
      const auth = req.auth;
      if (!auth) throw new Error('unreachable: the access hook authenticates');
      const { db, keyring } = app.ctx;
      const visible = await visibleAccountIds(db, auth);
      const dk = await keyring.forHousehold(auth.householdId);
      const list = await listAccounts(db, dk, visible);
      return { accounts: list.map((a) => toInfo(a, auth)) };
    },
  );

  r.patch(
    '/accounts/:id',
    {
      config: { access: 'member' },
      schema: {
        tags: ['accounts'],
        security,
        params: accountIdParams,
        body: updateAccountRequest,
        response: { 200: accountInfo, '4xx': errorResponse },
      },
    },
    async (req) => {
      const auth = req.auth;
      if (!auth) throw new Error('unreachable: the access hook authenticates');
      const { db, keyring } = app.ctx;
      const dk = await keyring.forHousehold(auth.householdId);
      const updated = await updateOwnAccount(db, dk, auth, req.params.id, req.body);
      // Owner only. Non-owners (admins included) and unknown ids get the same 404.
      if (!updated) throw new HttpError(404, 'not_found', 'Account not found');
      return toInfo(updated, auth);
    },
  );
}

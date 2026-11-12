import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { buildApp } from '@budgedino/server/app';
import { DEFAULT_CATEGORIES } from '@budgedino/server/categorization/defaults';
import type { DataKey } from '@budgedino/server/crypto';
import { categories, transactions } from '@budgedino/server/db/schema';
import { parseEcbXml, type FxSource } from '@budgedino/server/fx/ecb';
import { refreshFxRates } from '@budgedino/server/fx/service';
import { Keyring } from '@budgedino/server/households/keyring';
import { createLogger } from '@budgedino/server/observability/logger';
import { createAccount } from '@budgedino/server/repositories/accounts';
import { createTransaction } from '@budgedino/server/repositories/transactions';
import {
  createHousehold,
  createTestConnector,
  createTestMember,
  createTestSession,
  randomMasterKey,
} from './factories.js';
import type { TestDatabase } from './postgres.js';

export const NOW = new Date('2026-11-09T12:00:00Z'); // Monday, ISO week 2026-W46, November

const fixtureXml = readFileSync(
  fileURLToPath(new URL('../fixtures/ecb-hist-90d.xml', import.meta.url)),
  'utf8',
);
/** Fixture source: the recorded ECB 90-day XML, parsed by the production parser. */
export const fixtureFxSource: FxSource = { fetchRates: async () => parseEcbXml(fixtureXml) };

export const CANARY_PAYEE = 'CANARY-HIDDEN-PAYEE';

export interface World {
  app: FastifyInstance;
  keyring: Keyring;
  dk: DataKey;
  householdId: string;
  aId: string;
  bId: string;
  aToken: string;
  bToken: string;
  /** Household-visible accounts: A's own, B's own. */
  aAccount: string;
  bAccount: string;
  /** B's owner_only account that still counts toward budgets. */
  bHiddenCounting: string;
  /** B's household account with countsTowardBudgets=false. */
  bNotCounting: string;
  cat: Record<string, string>;
  add(
    accountId: string,
    amountMinor: bigint,
    bookingDate: string,
    category: string | null,
    extra?: { currency?: string; counterparty?: string; status?: 'pending' | 'booked' },
  ): Promise<string>;
  call(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    token: string,
    payload?: unknown,
  ): Promise<{ status: number; json: unknown; body: string }>;
}

/** A two-member household with default categories, FX rates and four accounts (see {@link World}). */
export async function createWorld(
  database: TestDatabase,
  appOverrides: Partial<Parameters<typeof buildApp>[0]> = {},
): Promise<World> {
  await database.reset();
  const master = randomMasterKey();
  const keyring = new Keyring(database.db, master);
  const app = buildApp({
    db: database.db,
    keyring,
    master,
    logger: createLogger({ level: 'silent' }),
    now: () => NOW,
    ...appOverrides,
  });
  await app.ready();
  await refreshFxRates(database.db, fixtureFxSource);

  const householdId = await createHousehold(database.db, keyring);
  const dk = await keyring.forHousehold(householdId);
  await database.db.insert(categories).values(
    DEFAULT_CATEGORIES.map((c) => ({
      householdId,
      name: c.name,
      isIncome: c.isIncome ?? false,
      isTransfer: c.isTransfer ?? false,
    })),
  );
  const catRows = await database.db
    .select()
    .from(categories)
    .where(eq(categories.householdId, householdId));
  const cat = Object.fromEntries(catRows.map((c) => [c.name, c.id]));

  const aId = await createTestMember(database.db, keyring, householdId, { role: 'admin' });
  const bId = await createTestMember(database.db, keyring, householdId, { role: 'member' });
  const aToken = await createTestSession(database.db, keyring, householdId, aId, NOW);
  const bToken = await createTestSession(database.db, keyring, householdId, bId, NOW);
  const ca = await createTestConnector(database.db, keyring, householdId, aId);
  const cb = await createTestConnector(database.db, keyring, householdId, bId);
  const mk = (
    connectorId: string,
    owner: string,
    ref: string,
    extra: { visibility?: 'household' | 'owner_only'; countsTowardBudgets?: boolean } = {},
  ) =>
    createAccount(database.db, dk, {
      connectorId,
      ownerMemberId: owner,
      externalRef: ref,
      name: ref,
      kind: 'checking',
      currency: 'EUR',
      ...extra,
    });
  const aAccount = await mk(ca, aId, 'a');
  const bAccount = await mk(cb, bId, 'b');
  const bHiddenCounting = await mk(cb, bId, 'b-hidden', {
    visibility: 'owner_only',
    countsTowardBudgets: true,
  });
  const bNotCounting = await mk(cb, bId, 'b-nocount', { countsTowardBudgets: false });

  let n = 0;
  return {
    app,
    keyring,
    dk,
    householdId,
    aId,
    bId,
    aToken,
    bToken,
    aAccount,
    bAccount,
    bHiddenCounting,
    bNotCounting,
    cat,
    async add(accountId, amountMinor, bookingDate, category, extra = {}) {
      n += 1;
      const id = await createTransaction(database.db, dk, {
        accountId,
        dedupKey: `w${n}`,
        status: extra.status ?? 'booked',
        bookingDate,
        amountMinor,
        currency: extra.currency ?? 'EUR',
        ...(extra.counterparty === undefined ? {} : { counterparty: extra.counterparty }),
      });
      if (category !== null) {
        await database.db
          .update(transactions)
          .set({ categoryId: cat[category] as string, categorySource: 'manual' })
          .where(eq(transactions.id, id));
      }
      return id;
    },
    async call(method, url, token, payload) {
      const res = await app.inject({
        method,
        url: `/api/v1${url}`,
        headers: { authorization: `Bearer ${token}` },
        ...(payload === undefined ? {} : { payload: payload as object }),
      });
      return {
        status: res.statusCode,
        json: JSON.parse(res.body || 'null') as unknown,
        body: res.body,
      };
    },
  };
}

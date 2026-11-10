import { and, eq } from 'drizzle-orm';
import { money } from '@budgedino/shared';
import { hashPassword } from '../auth/passwords.js';
import { generateTotpSecret } from '../auth/totp.js';
import { insertBudget, listBudgets } from '../budgets/service.js';
import { categorizeTransactions } from '../categorization/rules.js';
import type { FakeTx } from '../connectors/fake/fake-connector.js';
import type { ProviderTransaction } from '../connectors/types.js';
import { encryptField } from '../crypto/index.js';
import type { Db } from '../db/client.js';
import { newId } from '../db/ids.js';
import { categories, connectors, households, members } from '../db/schema.js';
import { bootstrapHousehold } from '../households/bootstrap.js';
import { createInvite } from '../households/invites.js';
import type { Keyring } from '../households/keyring.js';
import { createAccount } from '../repositories/accounts.js';
import { encryptConnectorState } from '../repositories/connectors.js';
import { createMember, decryptTotpSecret, normalizeEmail } from '../repositories/members.js';
import { ingest } from '../sync/ingest.js';
import { generateDemoTransactions } from './demo-data.js';

export const DEMO_HOUSEHOLD_NAME = 'BudgeDino Demo';
export const DEMO_TIMEZONE = 'Europe/Berlin';
export const DEMO_EMAIL = 'demo@budgedino.test';
/** Dev-only credential of the demo member; the seed refuses to run in production. */
export const DEMO_PASSWORD = 'demo-password-1234';
const DEMO_ACCOUNT_REF = 'demo-giro';
/** Connector config the app's "Demo bank" sends: a decoupled challenge the user confirms. */
export const DEMO_CONNECTOR_CONFIG = { scenario: 'decoupled' } as const;

const BASE32 = /^[A-Z2-7]{16,}$/;

/** Thrown when the seed is invoked where it must never run, or with an invalid setup. */
export class SeedError extends Error {}

/** The dev seed creates a known password and prints a TOTP secret: it must never touch a production deployment. */
export function assertSeedAllowed(env: Record<string, string | undefined>): void {
  if (env['NODE_ENV'] === 'production') {
    throw new SeedError('dev-seed refuses to run when NODE_ENV=production');
  }
}

export interface SeedOptions {
  withData: boolean;
  env: Record<string, string | undefined>;
  now?: Date;
}

export interface SeedResult {
  householdId: string;
  householdCreated: boolean;
  /** One-time admin invite (a fresh one on every run). */
  inviteToken: string;
  inviteExpiresAt: Date;
  data?: {
    memberEmail: string;
    memberPassword: string;
    /** Stored TOTP secret of the demo member (dev only). */
    totpSecret: string;
    connectorId: string;
    transactionCount: number;
    budgetNames: string[];
  };
}

const BUDGET_SPECS = [
  { name: 'Groceries', category: 'Groceries', periodKind: 'monthly', minor: 50_000n },
  { name: 'Eating out', category: 'Eating out', periodKind: 'weekly', minor: 6_000n },
] as const;

function toProvider(tx: FakeTx): ProviderTransaction {
  return {
    providerId: tx.providerId,
    status: tx.status,
    bookingDate: tx.bookingDate,
    amount: money(BigInt(tx.amountMinor), tx.currency),
    ...(tx.counterparty === undefined ? {} : { counterparty: tx.counterparty }),
    ...(tx.purpose === undefined ? {} : { purpose: tx.purpose }),
    ...(tx.mcc === undefined ? {} : { mcc: tx.mcc }),
  };
}

/**
 * Idempotent dev seed: a demo household (created once, a fresh one-time admin invite on every run) and,
 * with `withData`, a demo member, a connected fake connector with ~60 days of transactions and two
 * budgets. Reuses the production services (bootstrap, member/account repositories, ingest, categorizer),
 * so everything is encrypted exactly like real data. Never logs transaction contents.
 */
export async function devSeed(
  deps: { db: Db; keyring: Keyring },
  options: SeedOptions,
): Promise<SeedResult> {
  assertSeedAllowed(options.env);
  const { db } = deps;
  const now = options.now ?? new Date();

  const [existing] = await db
    .select({ id: households.id })
    .from(households)
    .where(eq(households.name, DEMO_HOUSEHOLD_NAME));
  let householdId: string;
  let inviteToken: string;
  let inviteExpiresAt: Date;
  if (existing) {
    householdId = existing.id;
    const invite = await createInvite(db, { householdId, role: 'admin', now });
    inviteToken = invite.token;
    inviteExpiresAt = invite.expiresAt;
  } else {
    const created = await bootstrapHousehold(deps, {
      name: DEMO_HOUSEHOLD_NAME,
      timezone: DEMO_TIMEZONE,
      now,
    });
    householdId = created.householdId;
    inviteToken = created.inviteToken;
    inviteExpiresAt = created.inviteExpiresAt;
  }
  const result: SeedResult = {
    householdId,
    householdCreated: !existing,
    inviteToken,
    inviteExpiresAt,
  };
  if (options.withData) result.data = await seedData(deps, householdId, options, now);
  return result;
}

async function seedData(
  deps: { db: Db; keyring: Keyring },
  householdId: string,
  options: SeedOptions,
  now: Date,
): Promise<NonNullable<SeedResult['data']>> {
  const { db, keyring } = deps;
  const dk = await keyring.forHousehold(householdId);

  // Demo member (admin) with a TOTP secret the Maestro flows can derive codes from.
  const requested = options.env['BUDGEDINO_DEV_TOTP_SECRET']?.trim();
  if (requested && !BASE32.test(requested)) {
    throw new SeedError(
      'BUDGEDINO_DEV_TOTP_SECRET must be a base32 secret of at least 16 characters',
    );
  }
  const emailBidx = keyring.emailIndex(DEMO_EMAIL);
  const [found] = await db
    .select({ id: members.id, totpSecretEnc: members.totpSecretEnc })
    .from(members)
    .where(eq(members.emailBidx, emailBidx));
  let memberId: string;
  let totpSecret: string;
  if (found) {
    memberId = found.id;
    if (!found.totpSecretEnc) throw new SeedError('The demo member has no TOTP secret');
    totpSecret = decryptTotpSecret(dk, found.id, found.totpSecretEnc);
  } else {
    totpSecret = requested ?? generateTotpSecret();
    memberId = await createMember(db, dk, {
      householdId,
      role: 'admin',
      email: normalizeEmail(DEMO_EMAIL),
      emailBidx,
      displayName: 'Demo',
      passwordHash: await hashPassword(DEMO_PASSWORD),
      totpSecret,
    });
  }

  // Connected fake connector + account + transactions (once).
  const [haveConnector] = await db
    .select({ id: connectors.id })
    .from(connectors)
    .where(
      and(
        eq(connectors.householdId, householdId),
        eq(connectors.ownerMemberId, memberId),
        eq(connectors.type, 'fake'),
      ),
    );
  const txs = generateDemoTransactions({ today: now.toISOString().slice(0, 10) });
  let connectorId: string;
  if (haveConnector) {
    connectorId = haveConnector.id;
  } else {
    connectorId = newId();
    await db.insert(connectors).values({
      id: connectorId,
      householdId,
      ownerMemberId: memberId,
      type: 'fake',
      configEnc: encryptField(dk, JSON.stringify(DEMO_CONNECTOR_CONFIG), {
        table: 'connectors',
        column: 'config',
        rowId: connectorId,
      }),
      stateEnc: encryptConnectorState(dk, connectorId, {
        scenario: 'happy',
        accountRef: DEMO_ACCOUNT_REF,
        transactions: txs as never,
        fetchCount: 0,
      }),
      lastSuccessAt: now,
    });
    const accountId = await createAccount(db, dk, {
      connectorId,
      ownerMemberId: memberId,
      externalRef: DEMO_ACCOUNT_REF,
      name: 'Demo Giro',
      kind: 'checking',
      currency: 'EUR',
      balanceMinor: 245_000n,
    });
    const { inserted } = await ingest(db, dk, accountId, txs.map(toProvider), { now });
    await categorizeTransactions(db, keyring, householdId, inserted);
  }

  // Budgets by name (once each).
  const have = new Set((await listBudgets(db, dk, householdId)).map((b) => b.name));
  for (const spec of BUDGET_SPECS) {
    if (have.has(spec.name)) continue;
    const [category] = await db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.householdId, householdId), eq(categories.name, spec.category)));
    if (!category) throw new SeedError(`Default category missing: ${spec.category}`);
    await insertBudget(db, dk, householdId, {
      name: spec.name,
      categoryIds: [category.id],
      periodKind: spec.periodKind,
      amount: money(spec.minor, 'EUR'),
    });
  }

  return {
    memberEmail: DEMO_EMAIL,
    memberPassword: DEMO_PASSWORD,
    totpSecret,
    connectorId,
    transactionCount: txs.length,
    budgetNames: BUDGET_SPECS.map((b) => b.name),
  };
}

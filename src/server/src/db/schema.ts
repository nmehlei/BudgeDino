import { sql } from 'drizzle-orm';
import {
  boolean,
  customType,
  date,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { newId } from './ids.js';

/**
 * Column naming: `_enc` = application-level encrypted blob (see docs/specs/security.md),
 * `_bidx` = blind index (HMAC hex) for exact-match lookup / dedup. Everything else is plaintext by design:
 * dates, currency codes, enums, foreign keys, mcc, timezone, category names.
 */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

const id = () =>
  uuid('id')
    .primaryKey()
    .$defaultFn(() => newId());
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const ts = (name: string) => timestamp(name, { withTimezone: true });

export const households = pgTable('households', {
  id: id(),
  name: text('name').notNull(),
  timezone: text('timezone').notNull().default('Europe/Berlin'),
  baseCurrency: text('base_currency').notNull().default('EUR'),
  createdAt: createdAt(),
});

export const householdKeys = pgTable(
  'household_keys',
  {
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    wrappedKey: bytea('wrapped_key').notNull(),
    masterKeyId: text('master_key_id').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.householdId, t.version] }),
    uniqueIndex('household_keys_one_active')
      .on(t.householdId)
      .where(sql`${t.active}`),
  ],
);

export const members = pgTable(
  'members',
  {
    id: id(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['admin', 'member'] }).notNull(),
    emailBidx: text('email_bidx').notNull(),
    emailEnc: bytea('email_enc').notNull(),
    displayNameEnc: bytea('display_name_enc').notNull(),
    passwordHash: text('password_hash').notNull(),
    totpSecretEnc: bytea('totp_secret_enc'),
    /** Last consumed TOTP time step (epoch/30); a code is accepted only for a later step (replay guard). */
    totpLastStep: integer('totp_last_step'),
    createdAt: createdAt(),
    disabledAt: ts('disabled_at'),
  },
  (t) => [uniqueIndex('members_email_bidx_unique').on(t.emailBidx)],
);

export const invites = pgTable('invites', {
  id: id(),
  householdId: uuid('household_id')
    .notNull()
    .references(() => households.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  role: text('role', { enum: ['admin', 'member'] }).notNull(),
  expiresAt: ts('expires_at').notNull(),
  usedAt: ts('used_at'),
});

export const sessions = pgTable('sessions', {
  id: id(),
  memberId: uuid('member_id')
    .notNull()
    .references(() => members.id, { onDelete: 'cascade' }),
  deviceNameEnc: bytea('device_name_enc'),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: createdAt(),
  lastSeenAt: ts('last_seen_at'),
  revokedAt: ts('revoked_at'),
});

export const connectors = pgTable('connectors', {
  id: id(),
  householdId: uuid('household_id')
    .notNull()
    .references(() => households.id, { onDelete: 'cascade' }),
  ownerMemberId: uuid('owner_member_id')
    .notNull()
    .references(() => members.id),
  type: text('type').notNull(),
  status: text('status', { enum: ['ok', 'needs_attention', 'error', 'disabled'] })
    .notNull()
    .default('ok'),
  configEnc: bytea('config_enc').notNull(),
  stateEnc: bytea('state_enc'),
  lastSuccessAt: ts('last_success_at'),
  lastErrorCode: text('last_error_code'),
  consentExpiresAt: ts('consent_expires_at'),
  createdAt: createdAt(),
});

export const accounts = pgTable(
  'accounts',
  {
    id: id(),
    connectorId: uuid('connector_id')
      .notNull()
      .references(() => connectors.id, { onDelete: 'cascade' }),
    ownerMemberId: uuid('owner_member_id')
      .notNull()
      .references(() => members.id),
    externalRefBidx: text('external_ref_bidx').notNull(),
    /** Bank-side account reference (needed to fetch); null only for rows created before it was stored. */
    externalRefEnc: bytea('external_ref_enc'),
    nameEnc: bytea('name_enc').notNull(),
    ibanEnc: bytea('iban_enc'),
    kind: text('kind', {
      enum: ['checking', 'savings', 'credit_card', 'depot', 'other'],
    }).notNull(),
    currency: text('currency').notNull(),
    visibility: text('visibility', { enum: ['household', 'owner_only'] })
      .notNull()
      .default('household'),
    countsTowardBudgets: boolean('counts_toward_budgets').notNull().default(true),
    balanceEnc: bytea('balance_enc'),
    balanceAt: ts('balance_at'),
  },
  (t) => [uniqueIndex('accounts_connector_external_ref').on(t.connectorId, t.externalRefBidx)],
);

export const categories = pgTable('categories', {
  id: id(),
  householdId: uuid('household_id')
    .notNull()
    .references(() => households.id, { onDelete: 'cascade' }),
  // [call] category names are plaintext by design (see docs/specs/security.md)
  name: text('name').notNull(),
  group: text('group'),
  isIncome: boolean('is_income').notNull().default(false),
  isTransfer: boolean('is_transfer').notNull().default(false),
  archived: boolean('archived').notNull().default(false),
});

export const transactions = pgTable(
  'transactions',
  {
    id: id(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    dedupBidx: text('dedup_bidx').notNull(),
    status: text('status', { enum: ['pending', 'booked'] }).notNull(),
    bookingDate: date('booking_date', { mode: 'string' }).notNull(),
    valueDate: date('value_date', { mode: 'string' }),
    amountEnc: bytea('amount_enc').notNull(),
    currency: text('currency').notNull(),
    counterpartyEnc: bytea('counterparty_enc'),
    counterpartyBidx: text('counterparty_bidx'),
    purposeEnc: bytea('purpose_enc'),
    mcc: text('mcc'),
    categoryId: uuid('category_id').references(() => categories.id, { onDelete: 'set null' }),
    categorySource: text('category_source', {
      enum: ['rule', 'learned', 'heuristic', 'manual', 'none'],
    })
      .notNull()
      .default('none'),
    transferGroupId: uuid('transfer_group_id'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('transactions_account_dedup').on(t.accountId, t.dedupBidx),
    index('transactions_account_booking_date').on(t.accountId, t.bookingDate),
    index('transactions_transfer_group').on(t.transferGroupId),
  ],
);

/**
 * Dedup keys of pending rows that were absorbed into their booked twin (same row, new key). A bank that
 * keeps reporting the pre-authorisation matches the alias instead of creating a new pending row.
 */
export const transactionDedupAliases = pgTable(
  'transaction_dedup_aliases',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    dedupBidx: text('dedup_bidx').notNull(),
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.dedupBidx] })],
);

export const transactionSplits = pgTable('transaction_splits', {
  id: id(),
  transactionId: uuid('transaction_id')
    .notNull()
    .references(() => transactions.id, { onDelete: 'cascade' }),
  categoryId: uuid('category_id').references(() => categories.id, { onDelete: 'set null' }),
  amountEnc: bytea('amount_enc').notNull(),
});

export const rules = pgTable('rules', {
  id: id(),
  householdId: uuid('household_id')
    .notNull()
    .references(() => households.id, { onDelete: 'cascade' }),
  priority: integer('priority').notNull(),
  matchEnc: bytea('match_enc').notNull(),
  categoryId: uuid('category_id')
    .notNull()
    .references(() => categories.id, { onDelete: 'cascade' }),
  createdBy: uuid('created_by').references(() => members.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
});

export const budgets = pgTable('budgets', {
  id: id(),
  householdId: uuid('household_id')
    .notNull()
    .references(() => households.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  categoryIds: uuid('category_ids').array().notNull(),
  periodKind: text('period_kind', { enum: ['weekly', 'monthly'] }).notNull(),
  amountMinorEnc: bytea('amount_minor_enc').notNull(),
  currency: text('currency').notNull(),
  archived: boolean('archived').notNull().default(false),
});

export const syncRuns = pgTable('sync_runs', {
  id: id(),
  connectorId: uuid('connector_id')
    .notNull()
    .references(() => connectors.id, { onDelete: 'cascade' }),
  trigger: text('trigger', { enum: ['schedule', 'user'] }).notNull(),
  userPresent: boolean('user_present').notNull().default(false),
  startedAt: ts('started_at').notNull().defaultNow(),
  finishedAt: ts('finished_at'),
  outcome: text('outcome'),
  errorCode: text('error_code'),
});

export const challenges = pgTable('challenges', {
  id: id(),
  connectorId: uuid('connector_id')
    .notNull()
    .references(() => connectors.id, { onDelete: 'cascade' }),
  memberId: uuid('member_id')
    .notNull()
    .references(() => members.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['redirect', 'decoupled', 'code', 'image'] }).notNull(),
  payloadEnc: bytea('payload_enc').notNull(),
  status: text('status', {
    enum: ['open', 'answered', 'completed', 'expired', 'cancelled'],
  })
    .notNull()
    .default('open'),
  expiresAt: ts('expires_at').notNull(),
  createdAt: createdAt(),
});

export const notifications = pgTable('notifications', {
  id: id(),
  householdId: uuid('household_id')
    .notNull()
    .references(() => households.id, { onDelete: 'cascade' }),
  memberId: uuid('member_id').references(() => members.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  bodyEnc: bytea('body_enc'),
  createdAt: createdAt(),
  deliveredAt: ts('delivered_at'),
});

export const fxRates = pgTable(
  'fx_rates',
  {
    date: date('date', { mode: 'string' }).notNull(),
    currency: text('currency').notNull(),
    ratePerEur: numeric('rate_per_eur').notNull(),
  },
  (t) => [primaryKey({ columns: [t.date, t.currency] })],
);

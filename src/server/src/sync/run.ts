import { and, eq, max, sql } from 'drizzle-orm';
import { blindIndex, encryptField, type DataKey } from '../crypto/index.js';
import type { ConnectorRegistry } from '../connectors/registry.js';
import { UnknownConnectorError } from '../connectors/registry.js';
import type {
  Connector,
  ConnectorContext,
  ConnectorState,
  FetchResult,
} from '../connectors/types.js';
import type { Db, DbOrTx } from '../db/client.js';
import { newId } from '../db/ids.js';
import { accounts, connectors, notifications, syncRuns, transactions } from '../db/schema.js';
import type { Keyring } from '../households/keyring.js';
import type { Logger } from '../observability/logger.js';
import { safeErrorInfo } from '../observability/redact.js';
import { decryptConnectorState, encryptConnectorState } from '../repositories/connectors.js';
import { ingest } from './ingest.js';
import { isUnattendedBudgetExhausted } from './rate-guard.js';

const DAY_MS = 86_400_000;
/** Late bookings: every fetch re-requests this much of the already-synced range. */
const CURSOR_OVERLAP_DAYS = 7;

export type SyncTrigger = 'schedule' | 'user';

export type SyncOutcome =
  | 'ok'
  | 'needs_attention'
  | 'temporary'
  | 'bank_rate_limited'
  | 'rate_limited'
  | 'skipped'
  | 'error';

export interface SyncDeps {
  db: Db;
  keyring: Keyring;
  registry: ConnectorRegistry;
  logger: Logger;
  now: () => Date;
  /** Called once per run, after commit, with every inserted and updated transaction id (categorizer hook). */
  onIngested: (householdId: string, txIds: string[]) => Promise<void>;
}

export interface RunSyncOptions {
  /** Request IP of the user who triggered the run; forwarded to the bank as PSU IP. */
  psuIp?: string;
  /** Pre-created `sync_runs` row (the API answers with its id before the run starts). */
  runId?: string;
}

export interface RunSyncResult {
  runId: string;
  outcome: SyncOutcome;
}

/** Stable, value-free codes stored in `connectors.last_error_code` / `sync_runs.error_code`. */
const ERROR_CODES = {
  needs_attention: 'needs_attention',
  temporary: 'bank_temporary',
  bank_rate_limited: 'bank_rate_limited',
  unknown_connector: 'unknown_connector',
  failed: 'sync_failed',
} as const;

/** Inserts the `sync_runs` row for a run; the API uses this to hand out the run id up front. */
export async function createSyncRun(
  db: DbOrTx,
  connectorId: string,
  trigger: SyncTrigger,
  now: Date,
): Promise<string> {
  const id = newId();
  await db.insert(syncRuns).values({
    id,
    connectorId,
    trigger,
    userPresent: trigger === 'user',
    startedAt: now,
  });
  return id;
}

/**
 * Fetches and ingests the transactions of every account of a connector.
 *
 * One run at a time per connector (advisory transaction lock), so a user-triggered run and a scheduled
 * run never interleave their state writes. Unattended runs honour the connector's daily budget; user runs
 * do not count against it and are sent to the bank as user-present. The server never starts an
 * interactive bank dialog: `needs_attention` flips the connector and notifies its owner.
 */
export async function runSync(
  deps: SyncDeps,
  connectorId: string,
  trigger: SyncTrigger,
  options: RunSyncOptions = {},
): Promise<RunSyncResult> {
  const { db, logger } = deps;
  const runId = options.runId ?? (await createSyncRun(db, connectorId, trigger, deps.now()));
  try {
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${connectorId}, 0))`);
      return executeRun(deps, tx, connectorId, trigger, runId, options);
    });
    if (result.ingestedIds !== null) {
      try {
        await deps.onIngested(result.householdId, result.ingestedIds);
      } catch (err) {
        logger.error({ connectorId, error: safeErrorInfo(err) }, 'onIngested hook failed');
      }
    }
    return { runId, outcome: result.outcome };
  } catch (err) {
    const code =
      err instanceof UnknownConnectorError ? ERROR_CODES.unknown_connector : ERROR_CODES.failed;
    logger.error({ connectorId, runId, error: safeErrorInfo(err) }, 'sync failed');
    await db.transaction(async (tx) => {
      await tx
        .update(syncRuns)
        .set({ outcome: 'error', errorCode: code, finishedAt: deps.now() })
        .where(eq(syncRuns.id, runId));
      await tx
        .update(connectors)
        .set({ lastErrorCode: code })
        .where(eq(connectors.id, connectorId));
    });
    return { runId, outcome: 'error' };
  }
}

interface RunDone {
  outcome: SyncOutcome;
  householdId: string;
  /** null when no fetch succeeded (the hook is not called). */
  ingestedIds: string[] | null;
}

async function executeRun(
  deps: SyncDeps,
  tx: DbOrTx,
  connectorId: string,
  trigger: SyncTrigger,
  runId: string,
  options: RunSyncOptions,
): Promise<RunDone> {
  const now = deps.now();
  const [connector] = await tx.select().from(connectors).where(eq(connectors.id, connectorId));
  if (!connector) throw new Error('Connector not found');
  const finish = async (outcome: SyncOutcome, errorCode?: string): Promise<RunDone> => {
    await tx
      .update(syncRuns)
      .set({ outcome, errorCode: errorCode ?? null, finishedAt: deps.now() })
      .where(eq(syncRuns.id, runId));
    return { outcome, householdId: connector.householdId, ingestedIds: null };
  };

  // Scheduled runs only touch healthy connectors; a user may retry one that needs attention or errored.
  const runnable = trigger === 'user' ? connector.status !== 'disabled' : connector.status === 'ok';
  if (!runnable) return finish('skipped');

  const impl = deps.registry.get(connector.type);
  if (
    trigger === 'schedule' &&
    (await isUnattendedBudgetExhausted(
      tx,
      connectorId,
      now,
      runId,
      impl.rateLimit.maxUnattendedPerDay,
    ))
  ) {
    return finish('rate_limited');
  }

  const dk = await deps.keyring.forHousehold(connector.householdId);
  const ctx: ConnectorContext = {
    now: deps.now,
    userPresent: trigger === 'user',
    ...(trigger === 'user' && options.psuIp !== undefined ? { psuIp: options.psuIp } : {}),
    logger: deps.logger,
  };

  let state = decryptConnectorState(dk, connectorId, connector.stateEnc);
  const persistState = async (next: ConnectorState | undefined) => {
    if (next === undefined) return;
    state = next;
    await tx
      .update(connectors)
      .set({ stateEnc: encryptConnectorState(dk, connectorId, next) })
      .where(eq(connectors.id, connectorId));
  };

  const accountIds = await resolveAccounts(tx, dk, impl, connectorId, state, ctx);
  const ingestedIds: string[] = [];
  let failure: Exclude<FetchResult, { ok: true }> | null = null;
  for (const { accountId, ref } of accountIds) {
    const since = await syncCursor(tx, accountId);
    const result = await impl.fetchTransactions(state, ref, since, ctx);
    await persistState(result.state);
    if (!result.ok) {
      failure = result;
      break;
    }
    const { inserted, updated } = await ingest(tx, dk, accountId, result.transactions, { now });
    ingestedIds.push(...inserted, ...updated);
    if (result.balance !== undefined) {
      await tx
        .update(accounts)
        .set({
          balanceEnc: encryptField(dk, result.balance.minor.toString(), {
            table: 'accounts',
            column: 'balance',
            rowId: accountId,
          }),
          balanceAt: now,
        })
        .where(eq(accounts.id, accountId));
    }
  }

  if (failure === null) {
    await tx
      .update(connectors)
      .set({ status: 'ok', lastSuccessAt: now, lastErrorCode: null })
      .where(eq(connectors.id, connectorId));
    await finish('ok');
    return { outcome: 'ok', householdId: connector.householdId, ingestedIds };
  }

  const [outcome, errorCode] =
    failure.reason === 'needs_attention'
      ? (['needs_attention', ERROR_CODES.needs_attention] as const)
      : failure.reason === 'rate_limited'
        ? (['bank_rate_limited', ERROR_CODES.bank_rate_limited] as const)
        : (['temporary', ERROR_CODES.temporary] as const);
  await tx
    .update(connectors)
    .set({ lastErrorCode: errorCode })
    .where(eq(connectors.id, connectorId));
  if (outcome === 'needs_attention' && connector.status !== 'needs_attention') {
    await tx
      .update(connectors)
      .set({ status: 'needs_attention' })
      .where(eq(connectors.id, connectorId));
    await notifyAttention(tx, dk, connector);
  }
  await finish(outcome, errorCode);
  return { outcome, householdId: connector.householdId, ingestedIds };
}

/**
 * The connector's accounts as the bank knows them. Accounts store only a blind index of the bank
 * reference, so the references come from `listAccounts` and are matched to existing rows; accounts
 * discovered at the bank but not yet in BudgeDino are ignored (discovery happens after auth).
 */
async function resolveAccounts(
  tx: DbOrTx,
  dk: DataKey,
  impl: Connector,
  connectorId: string,
  state: ConnectorState,
  ctx: ConnectorContext,
): Promise<{ accountId: string; ref: string }[]> {
  const rows = await tx
    .select({ id: accounts.id, bidx: accounts.externalRefBidx })
    .from(accounts)
    .where(eq(accounts.connectorId, connectorId));
  if (rows.length === 0) return [];
  const byBidx = new Map(rows.map((r) => [r.bidx, r.id]));
  const out: { accountId: string; ref: string }[] = [];
  for (const provider of await impl.listAccounts(state, ctx)) {
    const accountId = byBidx.get(blindIndex(dk, 'account-external-ref', provider.ref));
    if (accountId) out.push({ accountId, ref: provider.ref });
  }
  return out;
}

/** Latest booked date minus the overlap, or null before the first sync. */
async function syncCursor(tx: DbOrTx, accountId: string): Promise<Date | null> {
  const [row] = await tx
    .select({ latest: max(transactions.bookingDate) })
    .from(transactions)
    .where(and(eq(transactions.accountId, accountId), eq(transactions.status, 'booked')));
  if (!row?.latest) return null;
  return new Date(Date.parse(`${row.latest}T00:00:00Z`) - CURSOR_OVERLAP_DAYS * DAY_MS);
}

/** The body names the connector type only: no amounts, payees or IBANs. */
async function notifyAttention(
  tx: DbOrTx,
  dk: DataKey,
  connector: typeof connectors.$inferSelect,
): Promise<void> {
  const id = newId();
  const body = JSON.stringify({
    connectorId: connector.id,
    message: `${connector.type} needs your attention`,
  });
  await tx.insert(notifications).values({
    id,
    householdId: connector.householdId,
    memberId: connector.ownerMemberId,
    kind: 'connector_attention',
    bodyEnc: encryptField(dk, body, { table: 'notifications', column: 'body', rowId: id }),
  });
}

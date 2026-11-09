import { and, desc, eq, isNull, max, notInArray, or } from 'drizzle-orm';
import { encryptField, type DataKey } from '../crypto/index.js';
import type { ConnectorRegistry } from '../connectors/registry.js';
import { UnknownConnectorError } from '../connectors/registry.js';
import type { ConnectorContext, ConnectorState, FetchResult } from '../connectors/types.js';
import type { Db, DbOrTx } from '../db/client.js';
import { newId } from '../db/ids.js';
import { accounts, connectors, notifications, syncRuns, transactions } from '../db/schema.js';
import type { Keyring } from '../households/keyring.js';
import type { Logger } from '../observability/logger.js';
import { safeErrorInfo } from '../observability/redact.js';
import { decryptExternalRef } from '../repositories/accounts.js';
import { decryptConnectorState, encryptConnectorState } from '../repositories/connectors.js';
import { ingest } from './ingest.js';
import { isUnattendedBudgetExhausted } from './rate-guard.js';

const DAY_MS = 86_400_000;
/** Late bookings: every fetch re-requests this much of the already-synced range. */
const CURSOR_OVERLAP_DAYS = 7;
/** This many consecutive failed runs put the connector into `error` (the scheduler then skips it). */
const ERROR_STREAK_LIMIT = 3;

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
  /** Test/metrics hook: fired when a run takes or gives back its connector lock connection. */
  onLockHeld?: (event: 'acquired' | 'released') => void;
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
 * One run at a time per connector: a session-level advisory lock on a dedicated connection (no DB
 * transaction is held open across bank HTTP), so a user-triggered run and a scheduled run never interleave
 * their state writes. Connector state is committed right after every FetchResult; ingest runs in one short
 * transaction per account. Unattended runs honour the connector's daily budget; user runs do not count
 * against it and are sent to the bank as user-present. The server never starts an interactive bank dialog:
 * `needs_attention` flips the connector and notifies its owner.
 */
export async function runSync(
  deps: SyncDeps,
  connectorId: string,
  trigger: SyncTrigger,
  options: RunSyncOptions = {},
): Promise<RunSyncResult> {
  const { db, logger } = deps;
  const runId = options.runId ?? (await createSyncRun(db, connectorId, trigger, deps.now()));
  const ingested: string[] = [];
  return withConnectorLock(deps, connectorId, async () => {
    // Authentication does not take this lock; the generation read here guards every write of this run.
    const [current] = await db
      .select({ generation: connectors.stateGeneration })
      .from(connectors)
      .where(eq(connectors.id, connectorId));
    const generation = current?.generation ?? -1;
    await db
      .update(syncRuns)
      .set({ connectorGeneration: generation })
      .where(eq(syncRuns.id, runId));
    try {
      const result = await executeRun(
        deps,
        connectorId,
        trigger,
        runId,
        options,
        ingested,
        generation,
      );
      await callHook(deps, result.householdId, result.fetched ? ingested : null, connectorId);
      return { runId, outcome: result.outcome };
    } catch (err) {
      const code =
        err instanceof UnknownConnectorError ? ERROR_CODES.unknown_connector : ERROR_CODES.failed;
      logger.error({ connectorId, runId, error: safeErrorInfo(err) }, 'sync failed');
      await recordError(deps, connectorId, runId, code, generation);
      if (ingested.length > 0) {
        const [row] = await db
          .select({ householdId: connectors.householdId })
          .from(connectors)
          .where(eq(connectors.id, connectorId));
        if (row) await callHook(deps, row.householdId, ingested, connectorId);
      }
      return { runId, outcome: 'error' };
    }
  });
}

/** Counting semaphore: callers beyond the limit wait without holding any resource. */
class Semaphore {
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  constructor(public limit: number) {}
  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }
  release(): void {
    const next = this.waiters.shift();
    if (next)
      next(); // hand the slot over
    else this.active -= 1;
  }
}

export const DEFAULT_MAX_CONCURRENT_SYNCS = 2;
const syncSlots = new Semaphore(DEFAULT_MAX_CONCURRENT_SYNCS);

/**
 * Process-wide cap on concurrent sync runs. Each run holds one pool connection for its advisory lock and
 * needs another for its queries, so the cap must stay well below the pool size.
 */
export function setMaxConcurrentSyncs(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('limit must be an integer >= 1');
  syncSlots.limit = limit;
}

/**
 * Runs `fn` while holding the session-level advisory lock of the connector on a dedicated connection.
 * Waits for a concurrency slot before taking any connection. If the lock cannot be taken or released
 * cleanly, the connection is destroyed instead of returned to the pool, so a possibly still locked
 * session is never reused.
 */
export async function withConnectorLock<T>(
  deps: Pick<SyncDeps, 'db' | 'logger' | 'onLockHeld'>,
  connectorId: string,
  fn: () => Promise<T>,
): Promise<T> {
  await syncSlots.acquire();
  try {
    const client = await deps.db.$client.connect();
    let destroy = false;
    try {
      try {
        await client.query('select pg_advisory_lock(hashtextextended($1, 0))', [connectorId]);
      } catch (err) {
        destroy = true;
        throw err;
      }
      deps.onLockHeld?.('acquired');
      try {
        return await fn();
      } finally {
        try {
          await client.query('select pg_advisory_unlock(hashtextextended($1, 0))', [connectorId]);
        } catch (err) {
          destroy = true;
          deps.logger.error({ connectorId, error: safeErrorInfo(err) }, 'advisory unlock failed');
        }
        deps.onLockHeld?.('released');
      }
    } finally {
      client.release(destroy);
    }
  } finally {
    syncSlots.release();
  }
}

async function callHook(
  deps: SyncDeps,
  householdId: string,
  ids: string[] | null,
  connectorId: string,
): Promise<void> {
  if (ids === null) return;
  try {
    await deps.onIngested(householdId, ids);
  } catch (err) {
    deps.logger.error({ connectorId, error: safeErrorInfo(err) }, 'onIngested hook failed');
  }
}

/**
 * Records an unexpected failure; after 3 consecutive failed runs (of the current authentication, a reconnect
 * resets the streak) the connector goes to `error`. Connector writes only apply while the run's generation
 * is still current; a superseded run changes neither status nor error code and notifies nobody.
 */
async function recordError(
  deps: SyncDeps,
  connectorId: string,
  runId: string,
  code: string,
  generation: number,
): Promise<void> {
  const { db } = deps;
  await db.transaction(async (tx) => {
    await tx
      .update(syncRuns)
      .set({ outcome: 'error', errorCode: code, finishedAt: deps.now() })
      .where(eq(syncRuns.id, runId));
    const guard = and(eq(connectors.id, connectorId), eq(connectors.stateGeneration, generation));
    const marked = await tx
      .update(connectors)
      .set({ lastErrorCode: code })
      .where(guard)
      .returning({ id: connectors.id });
    if (marked.length === 0) return; // superseded by a reconnect
    const [connector] = await tx.select().from(connectors).where(eq(connectors.id, connectorId));
    if (!connector || connector.status === 'error' || connector.status === 'disabled') return;
    // runs that never reached the bank do not break or extend a streak
    const recent = await tx
      .select({ outcome: syncRuns.outcome })
      .from(syncRuns)
      .where(
        and(
          eq(syncRuns.connectorId, connectorId),
          eq(syncRuns.connectorGeneration, generation),
          or(isNull(syncRuns.outcome), notInArray(syncRuns.outcome, ['rate_limited', 'skipped'])),
        ),
      )
      .orderBy(desc(syncRuns.startedAt), desc(syncRuns.id))
      .limit(ERROR_STREAK_LIMIT);
    if (recent.length === ERROR_STREAK_LIMIT && recent.every((r) => r.outcome === 'error')) {
      const flipped = await tx
        .update(connectors)
        .set({ status: 'error' })
        .where(guard)
        .returning({ id: connectors.id });
      if (flipped.length === 0) return;
      await notifyAttention(
        tx,
        await deps.keyring.forHousehold(connector.householdId),
        connector,
        `${connector.type} stopped syncing after repeated errors`,
      );
    }
  });
}

interface RunDone {
  outcome: SyncOutcome;
  householdId: string;
  /** True when at least one fetch succeeded (the ingest hook is then called). */
  fetched: boolean;
}

async function executeRun(
  deps: SyncDeps,
  connectorId: string,
  trigger: SyncTrigger,
  runId: string,
  options: RunSyncOptions,
  ingested: string[],
  generation: number,
): Promise<RunDone> {
  const { db } = deps;
  const now = deps.now();
  const [connector] = await db.select().from(connectors).where(eq(connectors.id, connectorId));
  if (!connector) throw new Error('Connector not found');
  const finish = async (
    outcome: SyncOutcome,
    fetched: boolean,
    errorCode?: string,
  ): Promise<RunDone> => {
    await db
      .update(syncRuns)
      .set({ outcome, errorCode: errorCode ?? null, finishedAt: deps.now() })
      .where(eq(syncRuns.id, runId));
    return { outcome, householdId: connector.householdId, fetched };
  };

  // Scheduled runs only touch healthy connectors; a user may retry one that needs attention or errored.
  const runnable = trigger === 'user' ? connector.status !== 'disabled' : connector.status === 'ok';
  if (!runnable) return finish('skipped', false);

  const impl = deps.registry.get(connector.type);
  if (
    trigger === 'schedule' &&
    (await isUnattendedBudgetExhausted(
      db,
      connectorId,
      now,
      runId,
      impl.rateLimit.maxUnattendedPerDay,
    ))
  ) {
    return finish('rate_limited', false);
  }

  const dk = await deps.keyring.forHousehold(connector.householdId);
  const ctx: ConnectorContext = {
    now: deps.now,
    userPresent: trigger === 'user',
    ...(trigger === 'user' && options.psuIp !== undefined ? { psuIp: options.psuIp } : {}),
    logger: deps.logger,
  };

  let state = decryptConnectorState(dk, connectorId, connector.stateEnc);
  // Committed immediately (own statement): a later failure in this run must not lose rotated state.
  // A (re)authentication bumps `state_generation`; this run then must not overwrite its newer state or status.
  const unchanged = and(eq(connectors.id, connectorId), eq(connectors.stateGeneration, generation));
  let superseded = false;
  const persistState = async (next: ConnectorState | undefined) => {
    if (next === undefined) return;
    state = next;
    const written = await db
      .update(connectors)
      .set({ stateEnc: encryptConnectorState(dk, connectorId, next) })
      .where(unchanged)
      .returning({ id: connectors.id });
    if (written.length === 0) {
      superseded = true;
      deps.logger.warn(
        { connectorId, runId },
        'sync: connector re-authenticated mid-run, state kept',
      );
    }
  };

  const accountRows = await db.select().from(accounts).where(eq(accounts.connectorId, connectorId));
  let failure: Exclude<FetchResult, { ok: true }> | null = null;
  for (const row of accountRows) {
    const ref = decryptExternalRef(dk, row);
    if (ref === null) {
      deps.logger.warn(
        { connectorId, accountId: row.id },
        'sync: account has no stored bank reference',
      );
      continue;
    }
    const since = await syncCursor(db, row.id);
    const result = await impl.fetchTransactions(state, ref, since, ctx);
    await persistState(result.state);
    if (!result.ok) {
      failure = result;
      break;
    }
    const balance = result.balance;
    await db.transaction(async (tx) => {
      const { inserted, updated } = await ingest(tx, dk, row.id, result.transactions, { now });
      ingested.push(...inserted, ...updated);
      if (balance !== undefined) {
        await tx
          .update(accounts)
          .set({
            balanceEnc: encryptField(dk, balance.minor.toString(), {
              table: 'accounts',
              column: 'balance',
              rowId: row.id,
            }),
            balanceAt: now,
          })
          .where(eq(accounts.id, row.id));
      }
    });
  }

  if (superseded) return finish('skipped', ingested.length > 0);
  if (failure === null) {
    await db
      .update(connectors)
      .set({ status: 'ok', lastSuccessAt: now, lastErrorCode: null })
      .where(unchanged);
    return finish('ok', true);
  }

  const [outcome, errorCode] =
    failure.reason === 'needs_attention'
      ? (['needs_attention', ERROR_CODES.needs_attention] as const)
      : failure.reason === 'rate_limited'
        ? (['bank_rate_limited', ERROR_CODES.bank_rate_limited] as const)
        : (['temporary', ERROR_CODES.temporary] as const);
  await db.update(connectors).set({ lastErrorCode: errorCode }).where(unchanged);
  if (outcome === 'needs_attention' && connector.status !== 'needs_attention') {
    await db.transaction(async (tx) => {
      await tx.update(connectors).set({ status: 'needs_attention' }).where(unchanged);
      await notifyAttention(tx, dk, connector, `${connector.type} needs your attention`);
    });
  }
  return finish(outcome, ingested.length > 0, errorCode);
}

/** Latest booked date minus the overlap, or null before the first sync. */
async function syncCursor(db: DbOrTx, accountId: string): Promise<Date | null> {
  const [row] = await db
    .select({ latest: max(transactions.bookingDate) })
    .from(transactions)
    .where(and(eq(transactions.accountId, accountId), eq(transactions.status, 'booked')));
  if (!row?.latest) return null;
  return new Date(Date.parse(`${row.latest}T00:00:00Z`) - CURSOR_OVERLAP_DAYS * DAY_MS);
}

/** The body carries the connector type only: no amounts, payees or IBANs. */
async function notifyAttention(
  tx: DbOrTx,
  dk: DataKey,
  connector: typeof connectors.$inferSelect,
  message: string,
): Promise<void> {
  const id = newId();
  const body = JSON.stringify({ connectorId: connector.id, message });
  await tx.insert(notifications).values({
    id,
    householdId: connector.householdId,
    memberId: connector.ownerMemberId,
    kind: 'connector_attention',
    bodyEnc: encryptField(dk, body, { table: 'notifications', column: 'body', rowId: id }),
  });
}

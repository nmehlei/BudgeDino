import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { syncRuns } from '../db/schema.js';
import { HttpError } from '../http/errors.js';
import { safeErrorInfo } from '../observability/redact.js';
import { createSyncRun, runSync, type SyncDeps } from './run.js';

/** A run without outcome that started this recently counts as queued or active. */
export const ACTIVE_RUN_WINDOW_MS = 15 * 60 * 1000;
/** Minimum spacing between user-triggered runs of one connector. */
export const USER_SYNC_MIN_INTERVAL_MS = 2 * 60 * 1000;

/** What the API needs from the sync engine: start a user run, and (for tests/shutdown) wait for runs. */
export interface SyncService {
  /**
   * Starts a user-present run in the background and resolves with its run id. If a run of the connector
   * (user or scheduled) is already queued or active, that run's id is returned instead (coalescing).
   * Throws a 429 HttpError with Retry-After when the previous user run started less than 2 minutes ago.
   */
  startUserRun(connectorId: string, psuIp: string | undefined): Promise<string>;
  /** Resolves when every run started through this service has finished. */
  idle(): Promise<void>;
}

export function createSyncService(deps: SyncDeps): SyncService {
  const inFlight = new Set<Promise<unknown>>();

  /** Coalesce / throttle / insert, serialised per connector so concurrent requests cannot both pass. */
  async function reserveRun(connectorId: string): Promise<{ runId: string; started: boolean }> {
    return deps.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`user-sync:${connectorId}`}, 0))`,
      );
      const now = deps.now();
      const [active] = await tx
        .select({ id: syncRuns.id })
        .from(syncRuns)
        .where(
          and(
            eq(syncRuns.connectorId, connectorId),
            isNull(syncRuns.outcome),
            gt(syncRuns.startedAt, new Date(now.getTime() - ACTIVE_RUN_WINDOW_MS)),
          ),
        )
        .orderBy(desc(syncRuns.startedAt))
        .limit(1);
      if (active) return { runId: active.id, started: false };
      const [lastUser] = await tx
        .select({ startedAt: syncRuns.startedAt })
        .from(syncRuns)
        .where(and(eq(syncRuns.connectorId, connectorId), eq(syncRuns.trigger, 'user')))
        .orderBy(desc(syncRuns.startedAt))
        .limit(1);
      if (lastUser) {
        const waitMs = lastUser.startedAt.getTime() + USER_SYNC_MIN_INTERVAL_MS - now.getTime();
        if (waitMs > 0) {
          throw new HttpError(
            429,
            'sync_throttled',
            'Please wait before syncing this connector again',
            { 'retry-after': String(Math.ceil(waitMs / 1000)) },
          );
        }
      }
      return { runId: await createSyncRun(tx, connectorId, 'user', now), started: true };
    });
  }

  return {
    async startUserRun(connectorId, psuIp) {
      const { runId, started } = await reserveRun(connectorId);
      if (!started) return runId;
      const p = runSync(deps, connectorId, 'user', {
        runId,
        ...(psuIp === undefined ? {} : { psuIp }),
      }).catch((err: unknown) => {
        deps.logger.error({ connectorId, runId, error: safeErrorInfo(err) }, 'user sync crashed');
      });
      inFlight.add(p);
      void p.finally(() => inFlight.delete(p));
      return runId;
    },
    async idle() {
      while (inFlight.size > 0) await Promise.all([...inFlight]);
    },
  };
}

import { eq, max } from 'drizzle-orm';
import { PgBoss } from 'pg-boss';
import { connectors, households, syncRuns } from '../db/schema.js';
import { safeErrorInfo } from '../observability/redact.js';
import { expireChallenges } from '../connectors/challenge-service.js';
import { runSync, type SyncDeps } from './run.js';
import { occurrencesBetween } from './scheduler.js';

export const SYNC_CONNECTOR_QUEUE = 'sync.connector';
export const SYNC_TICK_QUEUE = 'sync.tick';
export const CHALLENGES_EXPIRE_QUEUE = 'challenges.expire';
const EXPIRE_CRON = '* * * * *';
const TICK_CRON = '*/5 * * * *';
const DAY_MS = 86_400_000;

/**
 * Finds connectors due for an unattended run and hands each to `enqueue`; returns their ids.
 *
 * Only `ok` connectors qualify (`needs_attention` and `disabled` ones wait for the user). A connector is
 * due when a scheduled time of its type's default schedule (household time zone) fell after its last
 * scheduled run (or within the last 24 h for one that never ran) and not later than now. Missed
 * occurrences collapse into a single run. The per-day budget is enforced again in `runSync`.
 */
export async function tick(
  deps: SyncDeps,
  enqueue: (connectorId: string) => Promise<void>,
): Promise<string[]> {
  const now = deps.now();
  const rows = await deps.db
    .select({ id: connectors.id, type: connectors.type, timezone: households.timezone })
    .from(connectors)
    .innerJoin(households, eq(connectors.householdId, households.id))
    .where(eq(connectors.status, 'ok'));
  const lastRuns = await deps.db
    .select({ connectorId: syncRuns.connectorId, last: max(syncRuns.startedAt) })
    .from(syncRuns)
    .where(eq(syncRuns.trigger, 'schedule'))
    .groupBy(syncRuns.connectorId);
  const lastByConnector = new Map(lastRuns.map((r) => [r.connectorId, r.last]));

  const due: string[] = [];
  for (const row of rows) {
    let schedule;
    try {
      schedule = deps.registry.get(row.type).rateLimit.defaultSchedule;
    } catch (err) {
      deps.logger.warn({ connectorId: row.id, error: safeErrorInfo(err) }, 'sync tick: skipped');
      continue;
    }
    const since = lastByConnector.get(row.id) ?? new Date(now.getTime() - DAY_MS);
    if (occurrencesBetween(schedule, row.timezone, since, now).length > 0) due.push(row.id);
  }
  for (const id of due) await enqueue(id);
  return due;
}

export interface JobsOptions {
  connectionString: string;
  /** pg-boss worker polling interval (seconds, >= 0.5); default 2. */
  pollingIntervalSeconds?: number;
}

export interface JobsHandle {
  boss: PgBoss;
  /** Queues an unattended run; at most one queued or active job per connector. */
  enqueueConnector(connectorId: string): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Starts pg-boss: `sync.tick` every 5 minutes enqueues due connectors as `sync.connector` jobs
 * (policy `exclusive` + `singletonKey: connectorId`: one queued or active job per connector).
 * `challenges.expire` runs every minute and expires abandoned connect challenges.
 */
export async function startJobs(deps: SyncDeps, options: JobsOptions): Promise<JobsHandle> {
  const boss = new PgBoss({ connectionString: options.connectionString });
  boss.on('error', (err) => deps.logger.error({ error: safeErrorInfo(err) }, 'pg-boss error'));
  await boss.start();
  await boss.createQueue(SYNC_CONNECTOR_QUEUE, { policy: 'exclusive' });
  await boss.createQueue(SYNC_TICK_QUEUE, { policy: 'short' });
  await boss.createQueue(CHALLENGES_EXPIRE_QUEUE, { policy: 'short' });

  const enqueueConnector = async (connectorId: string): Promise<void> => {
    await boss.send(SYNC_CONNECTOR_QUEUE, { connectorId }, { singletonKey: connectorId });
  };
  const polling = options.pollingIntervalSeconds ?? 2;

  await boss.work<{ connectorId: string }>(
    SYNC_CONNECTOR_QUEUE,
    { pollingIntervalSeconds: polling },
    async (jobs) => {
      for (const job of jobs) await runSync(deps, job.data.connectorId, 'schedule');
    },
  );
  await boss.work(SYNC_TICK_QUEUE, { pollingIntervalSeconds: polling }, async () => {
    await tick(deps, enqueueConnector);
  });
  await boss.work(CHALLENGES_EXPIRE_QUEUE, { pollingIntervalSeconds: polling }, async () => {
    await expireChallenges(deps);
  });
  await boss.schedule(SYNC_TICK_QUEUE, TICK_CRON);
  await boss.schedule(CHALLENGES_EXPIRE_QUEUE, EXPIRE_CRON);

  return { boss, enqueueConnector, stop: () => boss.stop({ graceful: true }) };
}

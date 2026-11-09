import { safeErrorInfo } from '../observability/redact.js';
import { createSyncRun, runSync, type SyncDeps } from './run.js';

/** What the API needs from the sync engine: start a user run, and (for tests/shutdown) wait for runs. */
export interface SyncService {
  /** Creates the run row and starts the run in the background; resolves with the run id. */
  startUserRun(connectorId: string, psuIp: string | undefined): Promise<string>;
  /** Resolves when every run started through this service has finished. */
  idle(): Promise<void>;
}

export function createSyncService(deps: SyncDeps): SyncService {
  const inFlight = new Set<Promise<unknown>>();
  return {
    async startUserRun(connectorId, psuIp) {
      const runId = await createSyncRun(deps.db, connectorId, 'user', deps.now());
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

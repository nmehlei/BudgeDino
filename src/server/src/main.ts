import { realpathSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { buildApp, createIngestHook } from './app.js';
import { ConfigError, loadConfig, type Config } from './config.js';
import { createConnectorRegistry } from './connectors/registry.js';
import { createFakeConnector } from './connectors/fake/fake-connector.js';
import type { Connector } from './connectors/types.js';
import { createDb } from './db/client.js';
import { migrate } from './db/migrate.js';
import { EcbFxSource, type FxSource } from './fx/ecb.js';
import { Keyring } from './households/keyring.js';
import { createLogger, type Logger } from './observability/logger.js';
import { safeErrorInfo } from './observability/redact.js';
import { startTelemetry } from './observability/otel.js';
import { startJobs } from './sync/jobs.js';
import { setMaxConcurrentSyncs } from './sync/run.js';

export interface StartOptions {
  /** Exchange-rate source for the daily `fx.refresh` job; default: the ECB. */
  fxSource?: FxSource;
  logger?: Logger;
  /** pg-boss worker polling interval in seconds (tests lower it). */
  pollingIntervalSeconds?: number;
}

export interface RunningServer {
  /** Base URL, e.g. `http://127.0.0.1:8080`. */
  url: string;
  /** Stops accepting requests, drains running syncs, stops pg-boss and closes the database pool. */
  stop(): Promise<void>;
}

function connectorsFor(config: Config): Connector[] {
  return config.connectors.map((name) => {
    switch (name) {
      case 'fake':
        return createFakeConnector();
    }
  });
}

/**
 * Wires the server: database pool, migrations, app, background jobs, then listens. Telemetry is started
 * by the caller (`main`, or `instrument.ts` under `node --import`) before this module's dependencies load.
 */
export async function start(config: Config, options: StartOptions = {}): Promise<RunningServer> {
  const logger = options.logger ?? createLogger({ level: process.env['LOG_LEVEL'] ?? 'info' });
  setMaxConcurrentSyncs(config.maxConcurrentSyncs);
  const handle = createDb(config.databaseUrl);
  let jobs: Awaited<ReturnType<typeof startJobs>> | undefined;
  let app: ReturnType<typeof buildApp> | undefined;
  try {
    await migrate(handle.pool);
    const keyring = new Keyring(handle.db, config.master);
    const registry = createConnectorRegistry(connectorsFor(config));
    const now = () => new Date();
    const onIngested = createIngestHook({ db: handle.db, keyring, now });
    app = buildApp({
      db: handle.db,
      keyring,
      master: config.master,
      logger,
      registry,
      onIngested,
      ...(config.trustProxy === undefined ? {} : { trustProxy: config.trustProxy }),
    });
    jobs = await startJobs(
      { db: handle.db, keyring, registry, logger, now, onIngested },
      {
        connectionString: config.databaseUrl,
        fxSource: options.fxSource ?? new EcbFxSource(),
        ...(options.pollingIntervalSeconds === undefined
          ? {}
          : { pollingIntervalSeconds: options.pollingIntervalSeconds }),
      },
    );
    await app.listen({ port: config.port, host: config.host });
  } catch (err) {
    await jobs?.stop().catch(() => undefined);
    await app?.close().catch(() => undefined);
    await handle.close().catch(() => undefined);
    throw err;
  }
  const port = (app.server.address() as AddressInfo).port;
  logger.info({ port, connectors: config.connectors }, 'budgedino server listening');
  const running = app;
  const runningJobs = jobs;
  let stopped: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () =>
      (stopped ??= (async () => {
        await runningJobs.stop();
        await running.close(); // stops accepting, then waits for running syncs
        await handle.close();
      })()),
  };
}

/** Process entry: telemetry, config, start, graceful shutdown on SIGTERM/SIGINT. */
export async function main(env: Record<string, string | undefined> = process.env): Promise<void> {
  const telemetry = startTelemetry(env);
  let config: Config;
  try {
    config = loadConfig(env);
  } catch (err) {
    // Messages name variables and rules only, never values.
    process.stderr.write(`${err instanceof ConfigError ? err.message : 'Invalid configuration'}\n`);
    await telemetry.shutdown();
    process.exit(1);
  }
  const logger = createLogger({ level: env['LOG_LEVEL'] ?? 'info' });
  let server: RunningServer;
  try {
    server = await start(config, { logger });
  } catch (err) {
    logger.fatal({ error: safeErrorInfo(err) }, 'startup failed');
    await telemetry.shutdown();
    process.exit(1);
  }
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    server
      .stop()
      .catch((err: unknown) => logger.error({ error: safeErrorInfo(err) }, 'shutdown failed'))
      .then(() => telemetry.shutdown())
      .finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMain()) await main();

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { startTestDatabase } from '../support/postgres.js';

/** Smoke tests of the bundled output; run via `pnpm test:build` (builds first). */
const dist = (file: string) =>
  fileURLToPath(new URL(`../../src/server/dist/${file}`, import.meta.url));

describe('built server (plain Node)', () => {
  it('has been built', () => {
    expect(existsSync(dist('main.js')), 'run `pnpm build` first').toBe(true);
  });

  it('budgedino CLI prints help', () => {
    const out = execFileSync(process.execPath, [dist('cli.js'), '--help'], { encoding: 'utf8' });
    expect(out).toContain('Usage: budgedino <command>');
    for (const cmd of ['init-key', 'bootstrap', 'invite', 'rotate-master-key']) {
      expect(out).toContain(cmd);
    }
  });

  it('main exits 1 on invalid configuration without echoing values', () => {
    const res = spawnSync(process.execPath, [dist('main.js')], {
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '', DATABASE_URL: 'mysql://u:hunter2-secret@h/db' },
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('Invalid configuration');
    expect(res.stderr).toContain('DATABASE_URL');
    expect(res.stderr).not.toContain('hunter2');
  });

  it('instrument.js is a no-op without OTEL_EXPORTER_OTLP_ENDPOINT', () => {
    const res = spawnSync(
      process.execPath,
      ['--import', dist('instrument.js'), dist('cli.js'), 'help'],
      {
        encoding: 'utf8',
        env: { PATH: process.env['PATH'] ?? '' },
      },
    );
    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
  });
});

describe('OpenTelemetry under ESM (node --import dist/instrument.js)', () => {
  it('instruments http and pg of the built server and exports spans over OTLP', async () => {
    const database = await startTestDatabase();
    const received: { url: string; body: string }[] = [];
    const collector = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received.push({ url: req.url ?? '', body: Buffer.concat(chunks).toString('latin1') });
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      });
    });
    await new Promise<void>((r) => collector.listen(0, '127.0.0.1', r));
    const collectorPort = (collector.address() as AddressInfo).port;
    const appPort = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, '127.0.0.1', () => {
        const port = (probe.address() as AddressInfo).port;
        probe.close(() => resolve(port));
      });
    });
    const child = spawn(process.execPath, ['--import', dist('instrument.js'), dist('main.js')], {
      env: {
        PATH: process.env['PATH'] ?? '',
        DATABASE_URL: database.container.getConnectionUri(),
        BUDGEDINO_MASTER_KEY: randomBytes(32).toString('base64'),
        PORT: String(appPort),
        HOST: '127.0.0.1',
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${collectorPort}`,
        OTEL_BSP_SCHEDULE_DELAY: '100',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (c: Buffer) => (output += c.toString()));
    child.stderr.on('data', (c: Buffer) => (output += c.toString()));
    try {
      const base = `http://127.0.0.1:${appPort}`;
      for (let i = 0; i < 100; i += 1) {
        const up = await fetch(`${base}/api/v1/nope`).then(
          () => true,
          () => false,
        );
        if (up) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      const exited = new Promise<number | null>((r) => child.once('exit', r));
      child.kill('SIGTERM'); // graceful shutdown flushes the exporters
      expect(await exited, output).toBe(0);
      const traces = received
        .filter((r) => r.url === '/v1/traces')
        .map((r) => r.body)
        .join('\n');
      expect(traces, 'http server spans').toContain('/api/v1/nope');
      expect(traces, 'pg spans (migrations)').toContain('postgresql');
    } finally {
      child.kill('SIGKILL');
      collector.close();
      await database.stop();
    }
  }, 90_000);
});

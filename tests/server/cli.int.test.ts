import { randomBytes } from 'node:crypto';
import { PassThrough, Writable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '@budgedino/server/app';
import { generateTotpCode } from '@budgedino/server/auth/totp';
import { DEFAULT_CATEGORIES } from '@budgedino/server/categorization/defaults';
import { loadMasterKey } from '@budgedino/server/crypto';
import { runCli } from '@budgedino/server/cli';
import { Keyring } from '@budgedino/server/households/keyring';
import { createLogger } from '@budgedino/server/observability/logger';
import { startTestDatabase, type TestDatabase } from '../support/postgres.js';

let database: TestDatabase;

beforeAll(async () => {
  database = await startTestDatabase();
}, 120_000);

afterAll(async () => {
  await database.stop();
});

beforeEach(async () => {
  await database.reset();
});

class Capture extends Writable {
  text = '';
  override _write(chunk: Buffer, _enc: BufferEncoding, cb: () => void) {
    this.text += chunk.toString('utf8');
    cb();
  }
}

async function cli(argv: string[], env: Record<string, string> = {}, stdinText = '') {
  const stdin = new PassThrough();
  stdin.end(stdinText);
  const stdout = new Capture();
  const stderr = new Capture();
  const code = await runCli(argv, { env, stdin, stdout, stderr });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

const newKey = () => randomBytes(32).toString('base64');

describe('budgedino init-key', () => {
  it('prints the key once on stdout and accepts the confirmation of its last 6 characters', async () => {
    // The answer depends on the generated key, so stdin stays open until the key is printed.
    const stdin = new PassThrough();
    const stdout = new Capture();
    const stderr = new Capture();
    const run = runCli(['init-key'], { env: {}, stdin, stdout, stderr });
    while (!stdout.text.includes('\n')) await new Promise((r) => setTimeout(r, 10));
    const printed = stdout.text.trim();
    expect(printed).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    stdin.write(`${printed.slice(-6)}\n`);
    expect(await run).toBe(0);
    expect(() => loadMasterKey({ BUDGEDINO_MASTER_KEY: printed })).not.toThrow();
    // the key appears exactly once overall, and never on stderr
    expect(stdout.text.split(printed)).toHaveLength(2);
    expect(stderr.text).not.toContain(printed);
  });

  it('fails when the confirmation does not match', async () => {
    const res = await cli(['init-key'], {}, 'nope00\nnope01\nnope02\n');
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/not confirmed/i);
  });
});

describe('budgedino bootstrap / invite / rotate-master-key', () => {
  const dbEnv = () => ({ DATABASE_URL: database.container.getConnectionUri() });

  function parse(stdout: string, key: string): string {
    const m = new RegExp(`^${key}=(.+)$`, 'm').exec(stdout);
    if (!m?.[1]) throw new Error(`no ${key} in output`);
    return m[1];
  }

  async function registerWith(master: string, inviteToken: string) {
    const masterKey = loadMasterKey({ BUDGEDINO_MASTER_KEY: master });
    const app = buildApp({
      db: database.db,
      keyring: new Keyring(database.db, masterKey),
      master: masterKey,
      logger: createLogger({ level: 'silent' }),
    });
    try {
      const reg = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          inviteToken,
          email: 'owner@example.test',
          password: 'correct horse battery staple',
          displayName: 'Owner',
          deviceName: 'Pixel',
        },
      });
      expect(reg.statusCode).toBe(200);
      const body = reg.json<{ totpProvisioningUri: string; pendingId: string }>();
      const secret = new URL(body.totpProvisioningUri).searchParams.get('secret') as string;
      const confirm = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register/confirm',
        payload: { pendingId: body.pendingId, totpCode: generateTotpCode(secret, Date.now()) },
      });
      expect(confirm.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  }

  it('bootstrap creates household, key and default categories and prints a usable admin invite', async () => {
    const master = newKey();
    const res = await cli(
      ['bootstrap', '--household', 'Smith family', '--timezone', 'Europe/Berlin'],
      { ...dbEnv(), BUDGEDINO_MASTER_KEY: master },
    );
    expect(res.code).toBe(0);
    expect(res.stderr).not.toContain(master);
    expect(res.stdout).not.toContain(master);
    const householdId = parse(res.stdout, 'household_id');
    const invite = parse(res.stdout, 'invite_token');

    const { rows: hh } = await database.pool.query<{ name: string; timezone: string }>(
      'select name, timezone from households where id = $1',
      [householdId],
    );
    expect(hh).toEqual([{ name: 'Smith family', timezone: 'Europe/Berlin' }]);
    const { rows: keys } = await database.pool.query(
      'select 1 from household_keys where household_id = $1',
      [householdId],
    );
    expect(keys).toHaveLength(1);
    const { rows: cats } = await database.pool.query<{
      name: string;
      is_income: boolean;
      is_transfer: boolean;
    }>('select name, is_income, is_transfer from categories where household_id = $1', [
      householdId,
    ]);
    expect(cats.map((c) => c.name).sort()).toEqual(DEFAULT_CATEGORIES.map((c) => c.name).sort());
    expect(cats.filter((c) => c.is_income).map((c) => c.name)).toEqual(['Income']);
    expect(cats.filter((c) => c.is_transfer).map((c) => c.name)).toEqual(['Transfer']);
    const { rows: inv } = await database.pool.query<{ role: string }>('select role from invites');
    expect(inv).toEqual([{ role: 'admin' }]);

    await registerWith(master, invite);
    const { rows: members } = await database.pool.query<{ role: string }>(
      'select role from members',
    );
    expect(members).toEqual([{ role: 'admin' }]);
  });

  it('invite creates a member invite for an existing household', async () => {
    const master = newKey();
    const env = { ...dbEnv(), BUDGEDINO_MASTER_KEY: master };
    const boot = await cli(['bootstrap', '--household', 'H', '--timezone', 'Europe/Berlin'], env);
    const householdId = parse(boot.stdout, 'household_id');
    const res = await cli(['invite', '--household', householdId, '--role', 'member'], env);
    expect(res.code).toBe(0);
    await registerWith(master, parse(res.stdout, 'invite_token'));
    const { rows } = await database.pool.query<{ role: string }>('select role from members');
    expect(rows).toEqual([{ role: 'member' }]);
  });

  it('rejects bad arguments with a usage error and no changes', async () => {
    const env = { ...dbEnv(), BUDGEDINO_MASTER_KEY: newKey() };
    const noName = await cli(['bootstrap', '--timezone', 'Europe/Berlin'], env);
    expect(noName.code).toBe(2);
    const badZone = await cli(['bootstrap', '--household', 'H', '--timezone', 'Mars/Base'], env);
    expect(badZone.code).toBe(2);
    const badRole = await cli(['invite', '--household', 'x', '--role', 'root'], env);
    expect(badRole.code).toBe(2);
    const unknown = await cli(['frobnicate'], env);
    expect(unknown.code).toBe(2);
    const { rows } = await database.pool.query('select 1 from households');
    expect(rows).toHaveLength(0);
  });

  it('rotate-master-key rewraps keys under the new key from BUDGEDINO_NEW_MASTER_KEY', async () => {
    const oldKey = newKey();
    const nextKey = newKey();
    const boot = await cli(['bootstrap', '--household', 'H', '--timezone', 'Europe/Berlin'], {
      ...dbEnv(),
      BUDGEDINO_MASTER_KEY: oldKey,
    });
    expect(boot.code).toBe(0);

    const res = await cli(['rotate-master-key', '--server-stopped'], {
      ...dbEnv(),
      BUDGEDINO_MASTER_KEY: oldKey,
      BUDGEDINO_NEW_MASTER_KEY: nextKey,
    });
    expect(res.code).toBe(0);
    expect(res.stdout + res.stderr).not.toContain(oldKey);
    expect(res.stdout + res.stderr).not.toContain(nextKey);
    const { rows } = await database.pool.query<{ master_key_id: string }>(
      'select master_key_id from household_keys',
    );
    expect(rows).toEqual([{ master_key_id: loadMasterKey({ BUDGEDINO_MASTER_KEY: nextKey }).id }]);

    // old key no longer works
    const again = await cli(['rotate-master-key', '--server-stopped'], {
      ...dbEnv(),
      BUDGEDINO_MASTER_KEY: oldKey,
      BUDGEDINO_NEW_MASTER_KEY: newKey(),
    });
    expect(again.code).toBe(1);
  });

  it('rotate-master-key refuses without --server-stopped, warns first and changes nothing (R19)', async () => {
    const oldKey = newKey();
    await cli(['bootstrap', '--household', 'H'], { ...dbEnv(), BUDGEDINO_MASTER_KEY: oldKey });
    const before = await database.pool.query('select master_key_id from household_keys');
    const res = await cli(['rotate-master-key'], {
      ...dbEnv(),
      BUDGEDINO_MASTER_KEY: oldKey,
      BUDGEDINO_NEW_MASTER_KEY: newKey(),
    });
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('Stop all running servers first');
    expect(res.stderr).toContain('--server-stopped');
    const after = await database.pool.query('select master_key_id from household_keys');
    expect(after.rows).toEqual(before.rows);
  });

  it('rotate-master-key requires a new key distinct from the old one', async () => {
    const key = newKey();
    const missing = await cli(['rotate-master-key', '--server-stopped'], {
      ...dbEnv(),
      BUDGEDINO_MASTER_KEY: key,
    });
    expect(missing.code).toBe(2);
    const same = await cli(['rotate-master-key', '--server-stopped'], {
      ...dbEnv(),
      BUDGEDINO_MASTER_KEY: key,
      BUDGEDINO_NEW_MASTER_KEY: key,
    });
    expect(same.code).toBe(2);
  });
});

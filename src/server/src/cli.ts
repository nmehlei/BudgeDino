#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadMasterKey, MasterKeyError, type MasterKey } from './crypto/index.js';
import { createDb } from './db/client.js';
import { migrate } from './db/migrate.js';
import { bootstrapHousehold, isValidTimezone } from './households/bootstrap.js';
import { createInvite } from './households/invites.js';
import { Keyring } from './households/keyring.js';

export interface CliIo {
  env: Record<string, string | undefined>;
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
}

/** Exit codes: 0 ok, 1 runtime failure, 2 usage or configuration error. */
class UsageError extends Error {}

const USAGE = `Usage: budgedino <command> [options]

Commands:
  init-key                         Generate a master key (printed once on stdout)
  bootstrap --household <name> [--timezone <iana>]
                                   Create a household and print a one-time admin invite
  invite --household <id> [--role member|admin]
                                   Print a one-time invite token (default role: member)
  rotate-master-key                Re-wrap all keys: old key from BUDGEDINO_MASTER_KEY[_FILE],
                                   new key from BUDGEDINO_NEW_MASTER_KEY[_FILE]

Environment: DATABASE_URL, BUDGEDINO_MASTER_KEY or BUDGEDINO_MASTER_KEY_FILE`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const out = (text: string) => io.stdout.write(text);
  const err = (text: string) => io.stderr.write(text);
  try {
    const [command, ...rest] = argv;
    switch (command) {
      case 'init-key':
        return await initKey(io);
      case 'bootstrap':
        return await withKeyring(io, (ctx) => bootstrap(rest, ctx, out));
      case 'invite':
        return await withKeyring(io, (ctx) => invite(rest, ctx, out));
      case 'rotate-master-key':
        return await rotateMasterKey(io, out);
      default:
        throw new UsageError(command ? `Unknown command: ${command}` : 'Missing command');
    }
  } catch (e) {
    if (e instanceof UsageError || e instanceof MasterKeyError) {
      err(`${e.message}\n`);
      if (e instanceof UsageError) err(`\n${USAGE}\n`);
      return 2;
    }
    // Messages here never contain key material (see crypto module); no stack traces to the terminal.
    err(`Error: ${e instanceof Error ? e.message : 'unknown failure'}\n`);
    return 1;
  }
}

function options<T extends Record<string, { type: 'string' }>>(args: string[], spec: T) {
  try {
    return parseArgs({ args, options: spec, allowPositionals: false, strict: true }).values;
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : 'Invalid arguments');
  }
}

/** Line reader over an injectable stream. */
function lineReader(input: Readable) {
  const rl = createInterface({ input, crlfDelay: Infinity });
  const lines = rl[Symbol.asyncIterator]();
  return {
    async next(): Promise<string | null> {
      const { value, done } = await lines.next();
      return done ? null : String(value);
    },
    close: () => rl.close(),
  };
}

async function initKey(io: CliIo): Promise<number> {
  const key = randomBytes(32).toString('base64');
  const tail = key.slice(-6);
  // The key goes to stdout once, never through a logger. Everything else goes to stderr.
  io.stderr.write(
    'New master key (printed once). Store it in a password manager or secret store NOW.\n' +
      'Losing it means losing all data; there is no recovery.\n',
  );
  io.stdout.write(`${key}\n`);
  const reader = lineReader(io.stdin);
  try {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      io.stderr.write('Type the last 6 characters of the key to confirm you saved it: ');
      const answer = await reader.next();
      if (answer === null) break;
      if (answer.trim() === tail) {
        io.stderr.write('Confirmed.\n');
        return 0;
      }
      io.stderr.write('Does not match.\n');
    }
  } finally {
    reader.close();
  }
  io.stderr.write('Key not confirmed. Do not use the printed key; run init-key again.\n');
  return 1;
}

interface Ctx {
  keyring: Keyring;
  db: ReturnType<typeof createDb>['db'];
}

async function withKeyring(io: CliIo, fn: (ctx: Ctx) => Promise<number>): Promise<number> {
  const url = io.env['DATABASE_URL'];
  if (!url) throw new UsageError('DATABASE_URL is not set');
  const master = loadMasterKey(io.env);
  const handle = createDb(url);
  try {
    await migrate(handle.pool);
    return await fn({ db: handle.db, keyring: new Keyring(handle.db, master) });
  } finally {
    await handle.close();
  }
}

async function bootstrap(args: string[], ctx: Ctx, out: (t: string) => void): Promise<number> {
  const v = options(args, { household: { type: 'string' }, timezone: { type: 'string' } });
  const name = v.household?.trim();
  if (!name) throw new UsageError('--household <name> is required');
  const timezone = v.timezone ?? 'Europe/Berlin';
  if (!isValidTimezone(timezone)) throw new UsageError(`Unknown timezone: ${timezone}`);
  const result = await bootstrapHousehold(ctx, { name, timezone });
  out(`household_id=${result.householdId}\n`);
  out(`invite_token=${result.inviteToken}\n`);
  out(`invite_expires_at=${result.inviteExpiresAt.toISOString()}\n`);
  return 0;
}

async function invite(args: string[], ctx: Ctx, out: (t: string) => void): Promise<number> {
  const v = options(args, { household: { type: 'string' }, role: { type: 'string' } });
  if (!v.household || !UUID.test(v.household)) {
    throw new UsageError('--household <id> is required and must be a household id');
  }
  const role = v.role ?? 'member';
  if (role !== 'member' && role !== 'admin') throw new UsageError('--role must be member or admin');
  const created = await createInvite(ctx.db, {
    householdId: v.household,
    role,
    now: new Date(),
  });
  out(`invite_token=${created.token}\n`);
  out(`invite_expires_at=${created.expiresAt.toISOString()}\n`);
  return 0;
}

function loadNewMasterKey(env: CliIo['env']): MasterKey {
  if (!env['BUDGEDINO_NEW_MASTER_KEY'] && !env['BUDGEDINO_NEW_MASTER_KEY_FILE']) {
    throw new UsageError('Set BUDGEDINO_NEW_MASTER_KEY or BUDGEDINO_NEW_MASTER_KEY_FILE');
  }
  try {
    return loadMasterKey({
      BUDGEDINO_MASTER_KEY: env['BUDGEDINO_NEW_MASTER_KEY'],
      BUDGEDINO_MASTER_KEY_FILE: env['BUDGEDINO_NEW_MASTER_KEY_FILE'],
    });
  } catch (e) {
    if (e instanceof MasterKeyError) {
      throw new MasterKeyError(
        e.message.replaceAll('BUDGEDINO_MASTER_KEY', 'BUDGEDINO_NEW_MASTER_KEY'),
      );
    }
    throw e;
  }
}

async function rotateMasterKey(io: CliIo, out: (t: string) => void): Promise<number> {
  const oldMaster = loadMasterKey(io.env);
  const newMaster = loadNewMasterKey(io.env);
  if (oldMaster.id === newMaster.id)
    throw new UsageError('The new master key must differ from the old one');
  return withKeyring(io, async ({ keyring }) => {
    await keyring.rotateMaster(oldMaster, newMaster);
    out(
      `Rotated to master key id ${newMaster.id}. Point BUDGEDINO_MASTER_KEY at the new key before ` +
        'the next server start; stop running servers first, they still hold the old key.\n',
    );
    return 0;
  });
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

if (isMain()) {
  process.exitCode = await runCli(process.argv.slice(2), {
    env: process.env,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}

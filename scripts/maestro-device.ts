/**
 * Opt-in Maestro run on the USB-attached physical phone: `pnpm maestro:device`. Never part of
 * `ci/check.sh` or CI, and it never targets an emulator (it refuses when no physical device is attached).
 *
 * Prerequisites: the dev server runs (`pnpm dev:server`), the demo data is seeded
 * (`pnpm dev:seed -- --with-data`) and the development build is installed (`pnpm mobile:android`).
 *
 * Reads `.env.dev` (or `.env.dev.example`) for BUDGEDINO_DEV_TOTP_SECRET, derives the current TOTP code
 * and passes the flow variables to Maestro. Optional: SERVER_URL (default: this Mac's LAN IP, port 8080),
 * ANDROID_SERIAL (pick one device when several are attached).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { generateTotpCode } from '../src/server/src/auth/totp.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const FLOWS = ['login.yaml', 'home.yaml', 'connect-demo-bank.yaml'];

function loadEnvFile(): Record<string, string> {
  const file = [`${root}.env.dev`, `${root}.env.dev.example`].find((f) => existsSync(f));
  const values: Record<string, string> = {};
  if (!file) return values;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m?.[1] && !line.trimStart().startsWith('#')) values[m[1]] = m[2] ?? '';
  }
  return values;
}

function lanIp(): string {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  throw new Error('No LAN IPv4 address found; set SERVER_URL');
}

function physicalDevice(): string {
  const adb = spawnSync('adb', ['devices'], { encoding: 'utf8' });
  if (adb.status !== 0)
    throw new Error('adb is not available (is ANDROID_HOME/platform-tools on PATH?)');
  const serials = adb.stdout
    .split('\n')
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter(([serial, state]) => serial && state === 'device' && !serial.startsWith('emulator-'))
    .map(([serial]) => serial as string);
  const wanted = process.env['ANDROID_SERIAL'];
  if (wanted) {
    if (!serials.includes(wanted))
      throw new Error('ANDROID_SERIAL is not an attached physical device');
    return wanted;
  }
  if (serials.length === 0) {
    throw new Error(
      'No physical device attached and authorised (see `adb devices`); emulators are not supported',
    );
  }
  if (serials.length > 1) throw new Error('Several devices attached: set ANDROID_SERIAL');
  return serials[0] as string;
}

const env = { ...loadEnvFile(), ...process.env };
const secret = env['BUDGEDINO_DEV_TOTP_SECRET'];
if (!secret) throw new Error('BUDGEDINO_DEV_TOTP_SECRET is not set (see .env.dev.example)');
if (env['NODE_ENV'] === 'production') throw new Error('Refusing to run with NODE_ENV=production');

const device = physicalDevice();
const serverUrl = process.env['SERVER_URL'] ?? `http://${lanIp()}:${env['PORT'] ?? '8080'}`;
const result = spawnSync(
  'maestro',
  [
    '--device',
    device,
    'test',
    '-e',
    `SERVER_URL=${serverUrl}`,
    '-e',
    'EMAIL=demo@budgedino.test',
    '-e',
    'PASSWORD=demo-password-1234',
    '-e',
    `TOTP_CODE=${generateTotpCode(secret, Date.now())}`,
    ...FLOWS.map((f) => `${root}src/mobile/maestro/${f}`),
  ],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 1);

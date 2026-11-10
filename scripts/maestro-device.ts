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
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { generateTotpCode } from '../src/server/src/auth/totp.js';
import { parseTotpSecret } from './maestro-env.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const FLOWS = ['login.yaml', 'home.yaml', 'connect-demo-bank.yaml'];

/** Reads only BUDGEDINO_DEV_TOTP_SECRET from the env file (other lines hold shell syntax such as `${PORT:-8080}`). */
function loadTotpSecret(): string | undefined {
  const file = [`${root}.env.dev`, `${root}.env.dev.example`].find((f) => existsSync(f));
  return file ? parseTotpSecret(readFileSync(file, 'utf8')) : undefined;
}

function lanIp(): string {
  const all = networkInterfaces();
  const pick = (addrs: NetworkInterfaceInfo[] | undefined) =>
    addrs?.find((a) => a.family === 'IPv4' && !a.internal)?.address;
  const ip = pick(all['en0']) ?? Object.values(all).map(pick).find(Boolean);
  if (!ip) throw new Error('No LAN IPv4 address found; set SERVER_URL');
  process.stderr.write(`Using LAN IP ${ip} for the server URL (override with SERVER_URL).\n`);
  return ip;
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

const secret = process.env['BUDGEDINO_DEV_TOTP_SECRET'] ?? loadTotpSecret();
if (!secret) throw new Error('BUDGEDINO_DEV_TOTP_SECRET is not set (see .env.dev.example)');
if (process.env['NODE_ENV'] === 'production')
  throw new Error('Refusing to run with NODE_ENV=production');

process.stderr.write(
  'Reminder: the flows need a build with the app lock skipped: `BUDGEDINO_E2E=1 pnpm mobile:android` (stop any running Metro on port 8081 first; the flag comes from the Metro env).\n' +
    'Afterwards restart Metro without it (`pnpm --filter ./src/mobile start`) to restore the lock.\n',
);
const device = physicalDevice();
const serverUrl = process.env['SERVER_URL'] ?? `http://${lanIp()}:${process.env['PORT'] ?? '8080'}`;
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

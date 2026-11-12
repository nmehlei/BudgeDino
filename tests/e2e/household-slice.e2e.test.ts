import { PassThrough, Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateTotpCode } from '@budgedino/server/auth/totp';
import { runCli } from '@budgedino/server/cli';
import { loadConfig } from '@budgedino/server/config';
import type { FakeTx } from '@budgedino/server/connectors/fake/fake-connector';
import { createLogger } from '@budgedino/server/observability/logger';
import { start, type RunningServer } from '@budgedino/server/main';
import { startTestDatabase, type TestDatabase } from '../support/postgres.js';

/**
 * The whole household slice through the real entry point (`start`): CLI bootstrap, registration with
 * TOTP, invite, budget, two fake-bank connectors (one `owner_only`), sync, home, notifications, and an
 * at-rest check of the raw database.
 */

const CANARIES = {
  jessMerchant: 'CANARY-JESS-MERCHANT',
  jessPurpose: 'CANARY-JESS-PURPOSE',
  adminEmail: 'canary-admin@example.test',
  jessEmail: 'canary-jess@example.test',
  adminName: 'CANARY-ADMIN-NAME',
  jessName: 'CANARY-JESS-NAME',
  adminMerchant: 'CANARY-ADMIN-SHOP',
  adminIban: 'DE89370400440532013000',
  accountRef: 'CANARY-ACCOUNT-REF',
};
const PASSWORD = 'correct horse battery staple';
const today = new Date().toISOString().slice(0, 10);

let database: TestDatabase;
let server: RunningServer;
let master: string;
let adminInvite: string;

beforeAll(async () => {
  database = await startTestDatabase();
}, 120_000);

afterAll(async () => {
  await server?.stop();
  await database.stop();
});

class Capture extends Writable {
  text = '';
  override _write(chunk: Buffer, _enc: BufferEncoding, cb: () => void) {
    this.text += chunk.toString('utf8');
    cb();
  }
}

async function cli(argv: string[], env: Record<string, string>) {
  const stdin = new PassThrough();
  stdin.end();
  const stdout = new Capture();
  const stderr = new Capture();
  const code = await runCli(argv, { env, stdin, stdout, stderr });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

/** `init-key` asks to confirm the last 6 characters of the printed key, so stdin stays open until then. */
async function initKey(): Promise<string> {
  const stdin = new PassThrough();
  const stdout = new Capture();
  const stderr = new Capture();
  const run = runCli(['init-key'], { env: {}, stdin, stdout, stderr });
  while (!stdout.text.includes('\n')) await sleep(10);
  const key = stdout.text.trim();
  stdin.write(`${key.slice(-6)}\n`);
  expect(await run).toBe(0);
  return key;
}

const line = (out: string, key: string) => {
  const m = new RegExp(`^${key}=(.+)$`, 'm').exec(out);
  if (!m?.[1]) throw new Error(`no ${key} in CLI output`);
  return m[1];
};

interface Res {
  status: number;
  body: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
}
async function api(method: string, path: string, token?: string, payload?: object): Promise<Res> {
  const res = await fetch(`${server.url}/api/v1${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(payload ? { 'content-type': 'application/json' } : {}),
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  const body = await res.text();
  return { status: res.status, body, json: body ? JSON.parse(body) : null };
}

/** Registers with an invite and confirms TOTP; returns the session token. */
async function register(inviteToken: string, email: string, displayName: string, device: string) {
  const reg = await api('POST', '/auth/register', undefined, {
    inviteToken,
    email,
    password: PASSWORD,
    displayName,
    deviceName: device,
  });
  expect(reg.status, reg.body).toBe(200);
  const secret = new URL(reg.json.totpProvisioningUri).searchParams.get('secret') as string;
  const confirm = await api('POST', '/auth/register/confirm', undefined, {
    pendingId: reg.json.pendingId,
    totpCode: generateTotpCode(secret, Date.now()),
  });
  expect(confirm.status, confirm.body).toBe(200);
  return confirm.json.sessionToken as string;
}

const tx = (id: string, minor: string, counterparty: string, purpose: string): FakeTx => ({
  providerId: id,
  status: 'booked',
  bookingDate: today,
  amountMinor: minor,
  currency: 'EUR',
  counterparty,
  purpose,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function eventually<T>(fn: () => Promise<T>, check: (v: T) => boolean, what: string) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const value = await fn();
    if (check(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

const state = {
  householdId: '',
  groceriesId: '',
  admin: '',
  jess: '',
  adminConnectorId: '',
  jessConnectorId: '',
  budgetId: '',
};

interface Home {
  budgets: { name: string; spent: { minor: string }; ratio: string }[];
  breakdown: { name: string; spent: { minor: string } }[];
}
const home = async (token: string) => (await api('GET', '/home', token)).json as Home;
const groceriesSpent = (h: Home) => h.budgets.find((b) => b.name === 'Groceries')?.spent.minor;
const notificationsOf = async (token: string) =>
  (await api('GET', '/notifications', token)).json.notifications as {
    kind: string;
    body: string;
  }[];

/** Connects a `fake` connector and answers its challenge; returns the connector id. */
async function connect(token: string, config: object, answer?: object): Promise<string> {
  const res = await api('POST', '/connectors', token, { type: 'fake', config });
  expect(res.status, res.body).toBe(200);
  if (res.json.challenge) {
    expect(answer, 'challenge needs an answer').toBeDefined();
    if (res.json.challenge.kind === 'decoupled') await sleep(res.json.challenge.pollAfterMs + 200);
    const done = await api('POST', `/challenges/${res.json.challenge.id}/answer`, token, answer);
    expect(done.json, done.body).toEqual({ status: 'completed' });
  }
  return res.json.connectorId as string;
}

describe('household slice (e2e)', () => {
  it('starts the real server on a fresh database with only the fake connector', async () => {
    master = await initKey();
    const env = {
      DATABASE_URL: database.container.getConnectionUri(),
      BUDGEDINO_MASTER_KEY: master,
    };
    const boot = await cli(['bootstrap', '--household', 'Smith family'], env);
    expect(boot.code, boot.stderr).toBe(0);
    expect(boot.stdout + boot.stderr).not.toContain(master);
    state.householdId = line(boot.stdout, 'household_id');
    adminInvite = line(boot.stdout, 'invite_token');

    const config = loadConfig({ ...env, BUDGEDINO_CONNECTORS: 'fake', NODE_ENV: 'test' });
    server = await start(
      { ...config, port: 0, host: '127.0.0.1' },
      {
        logger: createLogger({ level: 'silent' }),
        pollingIntervalSeconds: 0.5,
        fxSource: {
          fetchRates: () => Promise.resolve([{ date: today, currency: 'USD', ratePerEur: '1.1' }]),
        },
      },
    );
    expect((await fetch(`${server.url}/api/v1/nope`)).status).toBe(404);
  });

  it('admin registers with TOTP and invites Jess, who registers too', async () => {
    state.admin = await register(adminInvite, CANARIES.adminEmail, CANARIES.adminName, 'Pixel');
    const invite = await api('POST', '/households/invites', state.admin, { role: 'member' });
    expect(invite.status, invite.body).toBe(201);
    state.jess = await register(
      invite.json.inviteToken,
      CANARIES.jessEmail,
      CANARIES.jessName,
      'Galaxy',
    );
    // members cannot invite
    expect((await api('POST', '/households/invites', state.jess, { role: 'member' })).status).toBe(
      403,
    );
    const { rows } = await database.pool.query(
      `select id from categories where household_id = $1 and name = 'Groceries'`,
      [state.householdId],
    );
    state.groceriesId = rows[0].id;
  });

  it('admin creates the Groceries budget of 500 euro per month', async () => {
    const res = await api('POST', '/budgets', state.admin, {
      name: 'Groceries',
      categoryIds: [state.groceriesId],
      periodKind: 'monthly',
      amount: { minor: '50000', currency: 'EUR' },
    });
    expect(res.status, res.body).toBe(201);
    state.budgetId = res.json.budget.id;
  });

  it('connects the admin bank (decoupled) and Jess her own (code, owner_only), then syncs', async () => {
    state.adminConnectorId = await connect(
      state.admin,
      {
        scenario: 'decoupled',
        accountRef: CANARIES.accountRef,
        transactions: [
          tx('a1', '-20000', 'REWE', 'Weekly shop'),
          tx('a2', '-14000', 'EDEKA', CANARIES.adminMerchant),
        ],
      },
      { kind: 'decoupled' },
    );
    state.jessConnectorId = await connect(
      state.jess,
      {
        scenario: 'code',
        accountRef: 'jess-1',
        transactions: [
          tx('j1', '-2468', 'REWE', CANARIES.jessPurpose),
          tx('j2', '-1357', CANARIES.jessMerchant, 'x'),
        ],
      },
      { kind: 'code', code: '123456' },
    );
    const accounts = await api('GET', '/accounts', state.jess);
    const own = (accounts.json.accounts as { id: string; isOwner: boolean }[]).filter(
      (a) => a.isOwner,
    );
    expect(own).toHaveLength(1);
    const hidden = await api('PATCH', `/accounts/${own[0]?.id}`, state.jess, {
      visibility: 'owner_only',
    });
    expect(hidden.status, hidden.body).toBe(200);
    expect(hidden.json).toMatchObject({ visibility: 'owner_only', countsTowardBudgets: false });

    // the post-connect syncs run in the background; a manual sync right after is throttled
    const throttled = await api('POST', `/connectors/${state.adminConnectorId}/sync`, state.admin);
    expect(throttled.status).toBe(429);
    expect(throttled.json.error).toBe('sync_throttled');
    // Jess cannot sync the admin's connector
    expect(
      (await api('POST', `/connectors/${state.adminConnectorId}/sync`, state.jess)).status,
    ).toBe(404);
  });

  it('GET /home shows Groceries spent 340 without Jess hidden transactions; no alert below 80%', async () => {
    // both background syncs must have landed, or "Jess's data is absent" would hold vacuously
    await eventually(
      () => home(state.jess),
      (v) => v.breakdown.find((b) => b.name === 'Groceries')?.spent.minor === '36468',
      "Jess's synced home",
    );
    const h = await eventually(
      () => home(state.admin),
      (v) => groceriesSpent(v) === '34000',
      'synced home',
    );
    expect(h.budgets).toHaveLength(1);
    expect(h.budgets[0]).toMatchObject({ name: 'Groceries', ratio: '0.6800' });
    expect(h.budgets[0]?.spent).toEqual({ minor: '34000', currency: 'EUR' });
    expect(h.breakdown.map((b) => [b.name, b.spent.minor])).toEqual([['Groceries', '34000']]);
    const raw = JSON.stringify(h);
    for (const hiddenText of [CANARIES.jessMerchant, CANARIES.jessPurpose]) {
      expect(raw).not.toContain(hiddenText);
    }
    // Jess's amounts (24.68 and 13.57) appear nowhere in the admin's view
    const minors = [...raw.matchAll(/"minor":"(-?\d+)"/g)].map((m) => m[1]);
    expect(minors).not.toContain('2468');
    expect(minors).not.toContain('1357');
    // Jess sees her own account in her breakdown, but the budget stays household-wide
    const jess = await home(state.jess);
    expect(groceriesSpent(jess)).toBe('34000');
    expect(jess.breakdown.find((b) => b.name === 'Groceries')?.spent.minor).toBe('36468');
    expect(
      (await notificationsOf(state.admin)).filter((n) => n.kind === 'budget_threshold'),
    ).toHaveLength(0);
  });

  it('crossing 80% (400 of 500) creates exactly one budget_threshold notification', async () => {
    await connect(state.admin, {
      scenario: 'happy',
      accountRef: 'admin-second',
      transactions: [tx('a3', '-6000', 'REWE', 'Top-up shop')],
    });
    const h = await eventually(
      () => home(state.admin),
      (v) => groceriesSpent(v) === '40000',
      'second sync',
    );
    expect(h.budgets[0]?.ratio).toBe('0.8000');
    const alerts = await eventually(
      () => notificationsOf(state.admin),
      (n) => n.some((x) => x.kind === 'budget_threshold'),
      'threshold notification',
    );
    expect(alerts.filter((n) => n.kind === 'budget_threshold')).toEqual([
      {
        id: expect.any(String),
        kind: 'budget_threshold',
        body: 'Groceries reached 80%',
        createdAt: expect.any(String),
      },
    ]);
  });

  it('keeps every sensitive value out of the raw database dump', async () => {
    const dump = await database.dumpData();
    expect(dump).toContain('COPY public.transactions'); // sanity: the dump really contains the data
    for (const canary of [...Object.values(CANARIES), '20000', '34000', '2468']) {
      if (/^\d+$/.test(canary)) continue; // plain amounts are too common as substrings of ids/timestamps
      expect(dump, `dump must not contain ${canary}`).not.toContain(canary);
      const hex = Buffer.from(canary, 'utf8').toString('hex');
      expect(dump.toLowerCase(), `dump must not contain hex of ${canary}`).not.toContain(hex);
    }
    expect(dump).not.toContain(master);
  });

  it('shuts down gracefully', async () => {
    await server.stop();
    await expect(fetch(`${server.url}/api/v1/nope`)).rejects.toThrow();
  });
});

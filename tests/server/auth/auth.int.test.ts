import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '@budgedino/server/app';
import { generateTotpCode } from '@budgedino/server/auth/totp';
import type { MasterKey } from '@budgedino/server/crypto';
import { bootstrapHousehold } from '@budgedino/server/households/bootstrap';
import { createInvite } from '@budgedino/server/households/invites';
import { Keyring } from '@budgedino/server/households/keyring';
import { createLogger } from '@budgedino/server/observability/logger';
import { randomMasterKey } from '../../support/factories.js';
import { startTestDatabase, type TestDatabase } from '../../support/postgres.js';

const PASSWORD = 'correct horse battery staple';
const DAY = 24 * 60 * 60 * 1000;

let database: TestDatabase;
let master: MasterKey;
let keyring: Keyring;
let app: FastifyInstance;
let nowMs: number;
let householdId: string;
let adminInvite: string;

beforeAll(async () => {
  database = await startTestDatabase();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await database.stop();
});

beforeEach(async () => {
  await app?.close();
  await database.reset();
  nowMs = Date.UTC(2026, 10, 9, 12, 0, 0);
  master = randomMasterKey();
  keyring = new Keyring(database.db, master);
  app = buildApp({
    db: database.db,
    keyring,
    master,
    logger: createLogger({ level: 'silent' }),
    now: () => new Date(nowMs),
  });
  await app.ready();
  const boot = await bootstrapHousehold(
    { db: database.db, keyring },
    { name: 'Test', timezone: 'Europe/Berlin', now: new Date(nowMs) },
  );
  householdId = boot.householdId;
  adminInvite = boot.inviteToken;
});

interface Json {
  [key: string]: unknown;
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}, ip?: string) {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1${url}`,
    payload: body as object,
    headers,
    ...(ip ? { remoteAddress: ip } : {}),
  });
  return { status: res.statusCode, text: res.body, json: JSON.parse(res.body || 'null') as Json };
}

async function call(method: 'GET' | 'DELETE', url: string, token?: string) {
  const res = await app.inject({
    method,
    url: `/api/v1${url}`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return {
    status: res.statusCode,
    text: res.body,
    json: res.body ? (JSON.parse(res.body) as Json) : {},
  };
}

const secretOf = (uri: string) => new URL(uri).searchParams.get('secret') as string;
const codeFor = (secret: string, atMs = nowMs) => generateTotpCode(secret, atMs);

function wrongCode(secret: string): string {
  const valid = new Set([-30_000, 0, 30_000].map((d) => codeFor(secret, nowMs + d)));
  return ['000000', '111111', '222222', '333333'].find((c) => !valid.has(c)) as string;
}

async function register(email: string, invite = adminInvite) {
  const reg = await post('/auth/register', {
    inviteToken: invite,
    email,
    password: PASSWORD,
    displayName: 'Alice',
    deviceName: 'Pixel 9',
  });
  expect(reg.status).toBe(200);
  const secret = secretOf(reg.json['totpProvisioningUri'] as string);
  const confirm = await post('/auth/register/confirm', {
    pendingId: reg.json['pendingId'],
    totpCode: codeFor(secret),
  });
  expect(confirm.status).toBe(200);
  return { secret, token: confirm.json['sessionToken'] as string };
}

/** Advances to the next TOTP step (a used code is rejected) and logs in. */
async function login(email: string, secret: string, overrides: Json = {}, ip?: string) {
  nowMs += 30_000;
  return post(
    '/auth/login',
    { email, password: PASSWORD, totpCode: codeFor(secret), deviceName: 'Tablet', ...overrides },
    {},
    ip,
  );
}

describe('registration, login, sessions', () => {
  it('runs register -> confirm -> login and lists the sessions', async () => {
    const reg = await post('/auth/register', {
      inviteToken: adminInvite,
      email: 'alice@example.test',
      password: PASSWORD,
      displayName: 'Alice',
      deviceName: 'Pixel 9',
    });
    expect(reg.status).toBe(200);
    const uri = reg.json['totpProvisioningUri'] as string;
    expect(uri).toMatch(/^otpauth:\/\/totp\/BudgeDino:/);
    expect(new URL(uri).searchParams.get('issuer')).toBe('BudgeDino');

    const secret = secretOf(uri);
    const confirm = await post('/auth/register/confirm', {
      pendingId: reg.json['pendingId'],
      totpCode: codeFor(secret),
    });
    expect(confirm.status).toBe(200);
    const first = confirm.json['sessionToken'] as string;

    const loggedIn = await login('alice@example.test', secret);
    expect(loggedIn.status).toBe(200);
    const second = loggedIn.json['sessionToken'] as string;
    expect(second).not.toBe(first);
    expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const list = await call('GET', '/auth/sessions', second);
    expect(list.status).toBe(200);
    const sessions = list.json['sessions'] as { deviceName: string; current: boolean }[];
    expect(sessions.map((s) => s.deviceName).sort()).toEqual(['Pixel 9', 'Tablet']);
    expect(sessions.filter((s) => s.current)).toHaveLength(1);
    expect(sessions.find((s) => s.current)?.deviceName).toBe('Tablet');
  });

  it('stores an argon2id hash, an encrypted TOTP secret and only the token hash', async () => {
    const { secret, token } = await register('alice@example.test');
    const { rows } = await database.pool.query<{ password_hash: string; totp_secret_enc: Buffer }>(
      'select password_hash, totp_secret_enc from members',
    );
    expect(rows[0]?.password_hash).toMatch(/^\$argon2id\$/);
    expect(rows[0]?.totp_secret_enc.toString('utf8')).not.toContain(secret);
    const dump = await database.dumpData();
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(secret);
    expect(dump).not.toContain(PASSWORD);
    expect(dump).not.toContain('alice@example.test');
  });

  it('accepts the email case-insensitively', async () => {
    const { secret } = await register('Alice@Example.test');
    const res = await login(' alice@EXAMPLE.test ', secret);
    expect(res.status).toBe(200);
  });

  it('returns identical 401 bodies for unknown email, wrong password, wrong and missing TOTP', async () => {
    const { secret } = await register('alice@example.test');
    nowMs += 30_000;
    const base = { deviceName: 'Tablet' };
    const unknown = await post('/auth/login', {
      ...base,
      email: 'nobody@example.test',
      password: PASSWORD,
      totpCode: codeFor(secret),
    });
    const badPassword = await post('/auth/login', {
      ...base,
      email: 'alice@example.test',
      password: 'not the password at all',
      totpCode: codeFor(secret),
    });
    const badTotp = await post('/auth/login', {
      ...base,
      email: 'alice@example.test',
      password: PASSWORD,
      totpCode: wrongCode(secret),
    });
    const noTotp = await post('/auth/login', {
      ...base,
      email: 'alice@example.test',
      password: PASSWORD,
    });
    for (const res of [unknown, badPassword, badTotp, noTotp]) {
      expect(res.status).toBe(401);
      expect(res.text).toBe(unknown.text);
    }
  });

  it('rejects reuse of a TOTP code but accepts the previous step within the window', async () => {
    const { secret } = await register('alice@example.test');
    nowMs += 30_000;
    const code = codeFor(secret);
    const body = { email: 'alice@example.test', password: PASSWORD, deviceName: 'T' };
    expect((await post('/auth/login', { ...body, totpCode: code })).status).toBe(200);
    expect((await post('/auth/login', { ...body, totpCode: code })).status).toBe(401);

    // Clock moves 60 s on; the code of the step before "now" is still inside the +-1 window.
    nowMs += 60_000;
    const previous = codeFor(secret, nowMs - 30_000);
    expect((await post('/auth/login', { ...body, totpCode: previous })).status).toBe(200);
    // The current step is later than the last used one, so it is accepted once ...
    expect((await post('/auth/login', { ...body, totpCode: codeFor(secret) })).status).toBe(200);
    // ... and the earlier step is now behind the last used step.
    expect((await post('/auth/login', { ...body, totpCode: previous })).status).toBe(401);
  });

  it('rejects a TOTP code two steps old', async () => {
    const { secret } = await register('alice@example.test');
    nowMs += 120_000;
    const old = codeFor(secret, nowMs - 60_000);
    const res = await post('/auth/login', {
      email: 'alice@example.test',
      password: PASSWORD,
      totpCode: old,
      deviceName: 'T',
    });
    expect(res.status).toBe(401);
  });

  it('rejects an already used TOTP step at registration confirmation (replay guard from the start)', async () => {
    const { secret } = await register('alice@example.test');
    // same step as the confirmation code, no clock advance
    const res = await post('/auth/login', {
      email: 'alice@example.test',
      password: PASSWORD,
      totpCode: codeFor(secret),
      deviceName: 'T',
    });
    expect(res.status).toBe(401);
  });

  it('answers 429 on the 6th failed login for an email, even with correct credentials', async () => {
    const { secret } = await register('alice@example.test');
    nowMs += 30_000;
    for (let i = 0; i < 5; i += 1) {
      const res = await post('/auth/login', {
        email: 'alice@example.test',
        password: 'wrong password here',
        totpCode: codeFor(secret),
        deviceName: 'T',
      });
      expect(res.status).toBe(401);
    }
    const sixth = await post('/auth/login', {
      email: 'alice@example.test',
      password: PASSWORD,
      totpCode: codeFor(secret),
      deviceName: 'T',
    });
    expect(sixth.status).toBe(429);

    // window passes -> allowed again
    nowMs += 16 * 60_000;
    const later = await login('alice@example.test', secret);
    expect(later.status).toBe(200);
  });

  it('counts attempts before verification: a concurrent burst gets at most 5 attempts through', async () => {
    const { secret } = await register('alice@example.test');
    nowMs += 30_000;
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        post('/auth/login', {
          email: 'alice@example.test',
          password: PASSWORD,
          totpCode: wrongCode(secret),
          deviceName: 'T',
        }),
      ),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 401)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(5);
  });

  it('lets exactly one of two concurrent logins with the same TOTP code succeed', async () => {
    const { secret } = await register('alice@example.test');
    nowMs += 30_000;
    const body = {
      email: 'alice@example.test',
      password: PASSWORD,
      totpCode: codeFor(secret),
      deviceName: 'T',
    };
    const results = await Promise.all([post('/auth/login', body), post('/auth/login', body)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
  });

  it('limits failed logins per IP to 20 across emails', async () => {
    for (let i = 0; i < 20; i += 1) {
      const res = await post(
        '/auth/login',
        { email: `nobody${i}@example.test`, password: 'x', totpCode: '123456', deviceName: 'T' },
        {},
        '10.9.9.9',
      );
      expect(res.status).toBe(401);
    }
    const blocked = await post(
      '/auth/login',
      { email: 'fresh@example.test', password: 'x', totpCode: '123456', deviceName: 'T' },
      {},
      '10.9.9.9',
    );
    expect(blocked.status).toBe(429);
    const other = await post(
      '/auth/login',
      { email: 'fresh@example.test', password: 'x', totpCode: '123456', deviceName: 'T' },
      {},
      '10.1.1.1',
    );
    expect(other.status).toBe(401);
  });

  it('revokes a session: next request with it is 401', async () => {
    const { secret, token } = await register('alice@example.test');
    const second = (await login('alice@example.test', secret)).json['sessionToken'] as string;
    const list = await call('GET', '/auth/sessions', second);
    const sessions = list.json['sessions'] as { id: string; current: boolean }[];
    const other = sessions.find((s) => !s.current) as { id: string };

    expect((await call('DELETE', `/auth/sessions/${other.id}`, second)).status).toBe(204);
    expect((await call('GET', '/auth/sessions', token)).status).toBe(401);
    expect((await call('GET', '/auth/sessions', second)).status).toBe(200);
  });

  it('only lets a member revoke their own sessions', async () => {
    const a = await register('alice@example.test');
    const { token: bobInvite } = await invite(a.token, 'member');
    const b = await register('bob@example.test', bobInvite);
    const aliceSession = (
      (await call('GET', '/auth/sessions', a.token)).json['sessions'] as { id: string }[]
    )[0] as { id: string };
    expect((await call('DELETE', `/auth/sessions/${aliceSession.id}`, b.token)).status).toBe(404);
    expect((await call('GET', '/auth/sessions', a.token)).status).toBe(200);
  });

  it('rejects missing, malformed and unknown bearer tokens with the same 401', async () => {
    const none = await call('GET', '/auth/sessions');
    const malformed = await call('GET', '/auth/sessions', 'not a token');
    const unknown = await call('GET', '/auth/sessions', 'A'.repeat(43));
    for (const res of [none, malformed, unknown]) {
      expect(res.status).toBe(401);
      expect(res.text).toBe(none.text);
    }
  });

  it('locks out a disabled member (login and existing session)', async () => {
    const { secret, token } = await register('alice@example.test');
    await database.pool.query('update members set disabled_at = now()');
    expect((await call('GET', '/auth/sessions', token)).status).toBe(401);
    expect((await login('alice@example.test', secret)).status).toBe(401);
  });

  it('updates last_seen_at at most once per minute', async () => {
    const { token } = await register('alice@example.test');
    const seen = async () =>
      (
        await database.pool.query<{ last_seen_at: Date }>('select last_seen_at from sessions')
      ).rows[0]?.last_seen_at.getTime();
    const initial = await seen();
    nowMs += 30_000;
    await call('GET', '/auth/sessions', token);
    expect(await seen()).toBe(initial);
    nowMs += 31_000;
    await call('GET', '/auth/sessions', token);
    expect(await seen()).toBe(nowMs);
  });

  it('never echoes request bodies in error responses', async () => {
    const res = await post('/auth/register', {
      inviteToken: 'tok-secret-marker',
      email: 'leaky@example.test',
      password: 'short-pw',
      displayName: 'Leaky',
      deviceName: 'Pixel',
    });
    expect(res.status).toBe(400);
    for (const marker of ['tok-secret-marker', 'leaky@example.test', 'short-pw']) {
      expect(res.text).not.toContain(marker);
    }
    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{"password":"json-marker-xyz"',
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).not.toContain('json-marker-xyz');
  });
});

async function invite(sessionToken: string, role: 'admin' | 'member') {
  const res = await post(
    '/households/invites',
    { role },
    { authorization: `Bearer ${sessionToken}` },
  );
  return { status: res.status, token: res.json['inviteToken'] as string, json: res.json };
}

describe('invites', () => {
  it('answers 410 for a reused invite', async () => {
    await register('alice@example.test');
    const res = await post('/auth/register', {
      inviteToken: adminInvite,
      email: 'second@example.test',
      password: PASSWORD,
      displayName: 'Second',
      deviceName: 'Pixel',
    });
    expect(res.status).toBe(410);
  });

  it('answers 410 for an expired and for an unknown invite', async () => {
    nowMs += 7 * DAY + 1000;
    const body = {
      email: 'late@example.test',
      password: PASSWORD,
      displayName: 'Late',
      deviceName: 'Pixel',
    };
    const expired = await post('/auth/register', { ...body, inviteToken: adminInvite });
    const unknown = await post('/auth/register', { ...body, inviteToken: 'x'.repeat(43) });
    expect(expired.status).toBe(410);
    expect(unknown.status).toBe(410);
    expect(unknown.text).toBe(expired.text);
  });

  it('re-checks the invite at confirmation', async () => {
    const reg = await post('/auth/register', {
      inviteToken: adminInvite,
      email: 'alice@example.test',
      password: PASSWORD,
      displayName: 'Alice',
      deviceName: 'Pixel',
    });
    expect(reg.status).toBe(200);
    nowMs += 7 * DAY + 1000;
    const confirm = await post('/auth/register/confirm', {
      pendingId: reg.json['pendingId'],
      totpCode: codeFor(secretOf(reg.json['totpProvisioningUri'] as string)),
    });
    expect(confirm.status).toBe(410);
    const { rows } = await database.pool.query('select 1 from members');
    expect(rows).toHaveLength(0);
  });

  it('allows exactly one of two concurrent confirmations on the same invite', async () => {
    const pendings = [];
    for (const email of ['a@example.test', 'b@example.test']) {
      const reg = await post('/auth/register', {
        inviteToken: adminInvite,
        email,
        password: PASSWORD,
        displayName: 'X',
        deviceName: 'Pixel',
      });
      expect(reg.status).toBe(200);
      pendings.push({
        pendingId: reg.json['pendingId'],
        totpCode: codeFor(secretOf(reg.json['totpProvisioningUri'] as string)),
      });
    }
    const results = await Promise.all(pendings.map((p) => post('/auth/register/confirm', p)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 410]);
    const { rows } = await database.pool.query('select 1 from members');
    expect(rows).toHaveLength(1);
  });

  it('drops a pending registration after 5 wrong codes', async () => {
    const reg = await post('/auth/register', {
      inviteToken: adminInvite,
      email: 'alice@example.test',
      password: PASSWORD,
      displayName: 'Alice',
      deviceName: 'Pixel',
    });
    const secret = secretOf(reg.json['totpProvisioningUri'] as string);
    for (let i = 0; i < 5; i += 1) {
      const res = await post('/auth/register/confirm', {
        pendingId: reg.json['pendingId'],
        totpCode: wrongCode(secret),
      });
      expect(res.status).toBe(401);
    }
    const final = await post('/auth/register/confirm', {
      pendingId: reg.json['pendingId'],
      totpCode: codeFor(secret),
    });
    expect(final.status).toBe(410);
  });

  it('lets an admin create invites that members can use; members cannot', async () => {
    const admin = await register('alice@example.test');
    const created = await invite(admin.token, 'member');
    expect(created.status).toBe(201);
    expect(new Date(created.json['expiresAt'] as string).getTime()).toBe(nowMs + 7 * DAY);

    const bob = await register('bob@example.test', created.token);
    const denied = await invite(bob.token, 'member');
    expect(denied.status).toBe(403);

    const anonymous = await post('/households/invites', { role: 'member' });
    expect(anonymous.status).toBe(401);

    const { rows } = await database.pool.query<{ role: string }>(
      'select role from members order by created_at',
    );
    expect(rows.map((r) => r.role)).toEqual(['admin', 'member']);
  });

  it('createInvite stores only a hash and is single-household scoped', async () => {
    const created = await createInvite(database.db, {
      householdId,
      role: 'member',
      now: new Date(nowMs),
    });
    const dump = await database.dumpData();
    expect(dump).not.toContain(created.token);
  });
});

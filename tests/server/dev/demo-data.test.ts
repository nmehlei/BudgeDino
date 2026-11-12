import { describe, expect, it } from 'vitest';
import { generateDemoTransactions } from '@budgedino/server/dev/demo-data';
import {
  assertSeedAllowed,
  devSeed,
  formatSeedOutput,
  SeedError,
} from '@budgedino/server/dev/seed';
import { runCli } from '@budgedino/server/cli';
import { PassThrough, Writable } from 'node:stream';

describe('generateDemoTransactions', () => {
  const today = '2026-11-09';

  it('is deterministic for the same date and seed, and differs for another seed', () => {
    const a = generateDemoTransactions({ today, seed: 7 });
    expect(generateDemoTransactions({ today, seed: 7 })).toEqual(a);
    expect(generateDemoTransactions({ today, seed: 8 })).not.toEqual(a);
  });

  it('covers about 60 days ending today', () => {
    const txs = generateDemoTransactions({ today });
    const dates = txs.map((t) => t.bookingDate).sort();
    expect(dates.at(-1)).toBe(today);
    const first = dates[0] ?? '';
    expect(first >= '2026-09-11').toBe(true);
    expect(first <= '2026-09-20').toBe(true);
    expect(txs.length).toBeGreaterThan(40);
  });

  it('contains the expected German payees, salary and subscription', () => {
    const txs = generateDemoTransactions({ today });
    const payees = new Set(txs.map((t) => t.counterparty));
    for (const p of ['REWE Markt', 'EDEKA Center', 'Netflix International B.V.', 'Acme GmbH']) {
      expect(payees.has(p)).toBe(true);
    }
    expect([...payees].some((p) => p?.startsWith('DB Vertrieb'))).toBe(true);
    expect(txs.some((t) => t.purpose === 'Gehalt' && BigInt(t.amountMinor) > 0n)).toBe(true);
  });

  it('uses integer minor units in EUR with unique provider ids; only salary is positive', () => {
    const txs = generateDemoTransactions({ today });
    for (const t of txs) {
      expect(t.amountMinor).toMatch(/^-?\d+$/);
      expect(t.currency).toBe('EUR');
      expect(t.status).toBe('booked');
      if (BigInt(t.amountMinor) > 0n) expect(t.counterparty).toBe('Acme GmbH');
    }
    expect(new Set(txs.map((t) => t.providerId)).size).toBe(txs.length);
  });

  it('has grocery and eating-out activity today or yesterday so current month and week show numbers', () => {
    const txs = generateDemoTransactions({ today });
    const eatingOut = (t: { counterparty?: string | undefined }) =>
      t.counterparty === 'Lieferando' || t.counterparty === "McDonald's";
    expect(txs.some((t) => t.bookingDate === today && t.counterparty === 'REWE Markt')).toBe(true);
    // Mondays: the weekly "Eating out" budget needs spending on the day itself, not only yesterday.
    expect(txs.some((t) => t.bookingDate === today && eatingOut(t))).toBe(true);
    expect(txs.some((t) => t.bookingDate === '2026-11-08' && eatingOut(t))).toBe(true);
  });

  it('rejects a malformed date', () => {
    expect(() => generateDemoTransactions({ today: 'tomorrow' })).toThrow();
  });
});

class Capture extends Writable {
  text = '';
  override _write(chunk: Buffer, _enc: BufferEncoding, cb: () => void) {
    this.text += chunk.toString('utf8');
    cb();
  }
}

describe('dev-seed opt-in guard', () => {
  it('assertSeedAllowed is opt-in: development or the flag, never production', () => {
    expect(() => assertSeedAllowed({})).toThrow(SeedError);
    expect(() => assertSeedAllowed({ NODE_ENV: 'staging' })).toThrow(SeedError);
    expect(() => assertSeedAllowed({ NODE_ENV: 'development' })).not.toThrow();
    expect(() => assertSeedAllowed({}, true)).not.toThrow();
    expect(() => assertSeedAllowed({ NODE_ENV: 'production' })).toThrow(/production/);
    expect(() => assertSeedAllowed({ NODE_ENV: 'production' }, true)).toThrow(/production/);
  });

  it('devSeed refuses before touching the database', async () => {
    const never = {} as never;
    await expect(
      devSeed({ db: never, keyring: never }, { withData: true, env: {} }),
    ).rejects.toThrow(SeedError);
    await expect(
      devSeed(
        { db: never, keyring: never },
        { withData: true, acknowledgedDev: true, env: { NODE_ENV: 'production' } },
      ),
    ).rejects.toThrow(/refuses/);
  });

  async function cli(argv: string[], env: Record<string, string>) {
    const stdout = new Capture();
    const stderr = new Capture();
    const stdin = new PassThrough();
    stdin.end();
    const code = await runCli(argv, { env, stdin, stdout, stderr });
    return { code, stdout: stdout.text, stderr: stderr.text };
  }

  it('the CLI refuses in production (even with the flag) and without opt-in, exit 2, no output', async () => {
    for (const [argv, env] of [
      [['dev-seed', '--with-data'], { NODE_ENV: 'production' }],
      [['dev-seed', '--i-know-this-is-dev'], { NODE_ENV: 'production' }],
      [['dev-seed', '--with-data'], {}],
    ] as const) {
      const r = await cli([...argv], { ...env });
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/dev-seed/);
      expect(r.stdout).toBe('');
    }
  });
});

describe('formatSeedOutput', () => {
  const result = {
    householdId: '00000000-0000-4000-8000-000000000001',
    householdCreated: true,
    inviteToken: 'invite-token-value',
    inviteExpiresAt: new Date('2026-11-16T12:00:00Z'),
    data: {
      memberEmail: 'demo@budgedino.test',
      memberPassword: 'demo-password-1234',
      totpSecret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
      connectorId: '00000000-0000-4000-8000-000000000002',
      transactionCount: 61,
      budgetNames: ['Groceries', 'Eating out'],
    },
  };

  it('prints only the allowed keys: no session token, master key, amounts or transaction contents', () => {
    const out = formatSeedOutput(result);
    const keys = out
      .trim()
      .split('\n')
      .map((l) => l.split('=')[0]);
    expect(keys).toEqual([
      'household_id',
      'invite_token',
      'invite_expires_at',
      'demo_connector_config',
      'demo_email',
      'demo_password',
      'dev_totp_secret',
      'demo_transactions',
      'demo_budgets',
    ]);
    expect(out).not.toMatch(/session|master|bearer|REWE|EDEKA|Netflix|Gehalt|EUR|€/i);
    expect(out).not.toMatch(/-?\d+[.,]\d{2}\b/);
  });
});

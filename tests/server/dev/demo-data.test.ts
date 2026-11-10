import { describe, expect, it } from 'vitest';
import { generateDemoTransactions } from '@budgedino/server/dev/demo-data';
import { assertSeedAllowed, devSeed, SeedError } from '@budgedino/server/dev/seed';
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

describe('dev-seed production guard', () => {
  it('assertSeedAllowed throws only in production', () => {
    expect(() => assertSeedAllowed({ NODE_ENV: 'production' })).toThrow(SeedError);
    expect(() => assertSeedAllowed({ NODE_ENV: 'development' })).not.toThrow();
    expect(() => assertSeedAllowed({})).not.toThrow();
  });

  it('devSeed refuses in production before touching the database', async () => {
    const never = {} as never;
    await expect(
      devSeed({ db: never, keyring: never }, { withData: true, env: { NODE_ENV: 'production' } }),
    ).rejects.toThrow(/refuses/);
  });

  it('the CLI refuses in production, with exit code 2, before needing a key or database', async () => {
    const stdout = new Capture();
    const stderr = new Capture();
    const stdin = new PassThrough();
    stdin.end();
    const code = await runCli(['dev-seed', '--with-data'], {
      env: { NODE_ENV: 'production' },
      stdin,
      stdout,
      stderr,
    });
    expect(code).toBe(2);
    expect(stderr.text).toContain('refuses');
    expect(stdout.text).toBe('');
  });
});

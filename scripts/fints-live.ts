/**
 * Opt-in live FinTS check against a real bank: `pnpm fints:live`. Never part of `ci/check.sh` or CI.
 *
 * Needs FINTS_LIVE_BANK (`dkb` | `comdirect`), FINTS_LIVE_USER, FINTS_LIVE_PIN and
 * BUDGEDINO_FINTS_PRODUCT_ID (optional BUDGEDINO_FINTS_PRODUCT_VERSION). It talks to the bank directly
 * (no database) and prints only: challenge kind and message, whether the selected TAN method needs a
 * TAN medium and how many media are active, account count and kinds, and the first checking account's
 * transaction count and booking date range. Never amounts, names, IBANs, PIN, user id or media names.
 * The TAN is read from the terminal without echo.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { createFinTSConnector } from '../src/server/src/connectors/fints/connector.js';
import { FinTSDialogRegistry } from '../src/server/src/connectors/fints/dialogs.js';
import { LibFintsPort } from '../src/server/src/connectors/fints/lib-fints-port.js';
import type {
  AuthStep,
  Challenge,
  ChallengeAnswer,
  ConnectorContext,
} from '../src/server/src/connectors/types.js';
import { createLogger } from '../src/server/src/observability/logger.js';
import {
  formatAccounts,
  formatChallenge,
  formatTanMedia,
  formatTransactionSummary,
} from './fints-live-format.js';

const DECOUPLED_DEADLINE_MS = 3 * 60_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const say = (line: string) => process.stdout.write(`${line}\n`);

/** Reads a line; without echo when stdin is a terminal, plainly from a pipe. */
async function prompt(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    const rl = createInterface({ input: stdin, output: process.stdout });
    try {
      return (await rl.question(question)).trim();
    } finally {
      rl.close();
    }
  }
  process.stdout.write(question);
  return new Promise<string>((resolve, reject) => {
    let buf = '';
    const finish = (fn: () => void) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\n');
      fn();
    };
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return finish(() => resolve(buf.trim()));
        if (ch === '\u0003') return finish(() => reject(new Error('aborted')));
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

async function answerFor(c: Challenge): Promise<ChallengeAnswer> {
  switch (c.kind) {
    case 'decoupled':
      await sleep(c.pollAfterMs);
      return { kind: 'decoupled' };
    case 'code':
      return { kind: 'code', code: await prompt('TAN (hidden): ') };
    case 'image': {
      const dir = await mkdtemp(join(tmpdir(), 'budgedino-fints-'));
      const file = join(dir, c.mimeType === 'image/png' ? 'challenge.png' : 'challenge.jpg');
      try {
        await writeFile(file, Buffer.from(c.imageBase64, 'base64'));
        say(`challenge image written to ${file}`);
        return { kind: 'image', code: await prompt('TAN (hidden): ') };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
    case 'redirect':
      throw new Error('unexpected redirect challenge');
  }
}

async function main(): Promise<number> {
  const bank = process.env['FINTS_LIVE_BANK'];
  const userId = process.env['FINTS_LIVE_USER'];
  const pin = process.env['FINTS_LIVE_PIN'];
  const productId = process.env['BUDGEDINO_FINTS_PRODUCT_ID'];
  if (!bank || !userId || !pin || !productId) {
    say(
      'Set FINTS_LIVE_BANK (dkb|comdirect), FINTS_LIVE_USER, FINTS_LIVE_PIN and BUDGEDINO_FINTS_PRODUCT_ID.',
    );
    return 2;
  }
  const dialogs = new FinTSDialogRegistry({ now: () => new Date() });
  const connector = createFinTSConnector({
    port: new LibFintsPort(),
    dialogs,
    product: { id: productId, version: process.env['BUDGEDINO_FINTS_PRODUCT_VERSION'] ?? '1.0' },
  });
  const ctx: ConnectorContext = {
    now: () => new Date(),
    userPresent: true,
    logger: createLogger({ level: 'silent' }),
  };
  const config = { bank, userId, pin };
  try {
    let step: AuthStep = await connector.startAuth(config, ctx);
    // Deadline per consecutive run of the same decoupled challenge (the SCA probe may add a second).
    let pending: { message: string; since: number } | undefined;
    while (!step.done) {
      if (step.challenge.kind === 'decoupled') {
        if (pending?.message !== step.challenge.message)
          pending = { message: step.challenge.message, since: Date.now() };
        if (Date.now() - pending.since > DECOUPLED_DEADLINE_MS)
          throw new Error('decoupled approval not completed within 3 minutes');
      } else pending = undefined;
      say(formatChallenge(step.challenge));
      step = await connector.continueAuth(step.dialog, await answerFor(step.challenge), ctx);
    }
    say('authenticated');
    say(formatTanMedia(step.state));

    const accounts = await connector.listAccounts(step.state, ctx, config);
    say(formatAccounts(accounts));
    const checking = accounts.find((a) => a.kind === 'checking');
    if (!checking) {
      say('FAILED: no checking account');
      return 1;
    }
    const since = new Date(Date.now() - 30 * 86_400_000);
    const result = await connector.fetchTransactions(step.state, checking.ref, since, ctx, config);
    if (!result.ok) {
      say(`FAILED: fetch failed (${result.reason})`);
      return 1;
    }
    say(formatTransactionSummary(result.transactions));
    return 0;
  } finally {
    dialogs.clear();
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    // Bank-layer errors are sanitised (fixed messages), so the class and message are safe to print.
    say(`FAILED: ${e instanceof Error ? `${e.name}: ${e.message}` : 'unknown error'}`);
    process.exit(1);
  },
);

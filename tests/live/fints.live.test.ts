import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { describe, expect, it } from 'vitest';
import { createFinTSConnector } from '@budgedino/server/connectors/fints/connector';
import { FinTSDialogRegistry } from '@budgedino/server/connectors/fints/dialogs';
import { LibFintsPort } from '@budgedino/server/connectors/fints/lib-fints-port';
import type {
  AuthStep,
  Challenge,
  ChallengeAnswer,
  ConnectorContext,
} from '@budgedino/server/connectors/types';
import { createLogger } from '@budgedino/server/observability/logger';
import { formatAccounts, formatChallenge, formatTransactionSummary } from './format';

/**
 * Opt-in live test against a real bank (`pnpm test:live`); never part of `ci/check.sh` or CI.
 * Needs FINTS_LIVE_BANK (`dkb` | `comdirect`), FINTS_LIVE_USER, FINTS_LIVE_PIN and
 * BUDGEDINO_FINTS_PRODUCT_ID; skipped unless all are set. It talks to the bank directly (no database)
 * and prints only: challenge kind and message, account count and kinds, and the first checking
 * account's transaction count and booking date range. Never amounts, names, IBANs, PIN or user id.
 */
const bank = process.env['FINTS_LIVE_BANK'];
const userId = process.env['FINTS_LIVE_USER'];
const pin = process.env['FINTS_LIVE_PIN'];
const productId = process.env['BUDGEDINO_FINTS_PRODUCT_ID'];
const enabled = Boolean(bank && userId && pin && productId);

const DECOUPLED_DEADLINE_MS = 3 * 60_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const say = (line: string) => process.stdout.write(`${line}\n`);

async function promptTan(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function answerFor(c: Challenge): Promise<ChallengeAnswer> {
  switch (c.kind) {
    case 'decoupled':
      await sleep(c.pollAfterMs);
      return { kind: 'decoupled' };
    case 'code':
      return { kind: 'code', code: await promptTan('TAN: ') };
    case 'image': {
      const dir = await mkdtemp(join(tmpdir(), 'budgedino-fints-'));
      const file = join(dir, c.mimeType === 'image/png' ? 'challenge.png' : 'challenge.jpg');
      try {
        await writeFile(file, Buffer.from(c.imageBase64, 'base64'));
        say(`challenge image written to ${file}`);
        return { kind: 'image', code: await promptTan('TAN: ') };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
    case 'redirect':
      throw new Error('unexpected redirect challenge');
  }
}

describe.skipIf(!enabled)('fints live (real bank, opt-in)', () => {
  it(
    'authenticates, lists accounts and fetches 30 days',
    async () => {
      const dialogs = new FinTSDialogRegistry({ now: () => new Date() });
      const connector = createFinTSConnector({
        port: new LibFintsPort(),
        dialogs,
        product: {
          id: productId ?? '',
          version: process.env['BUDGEDINO_FINTS_PRODUCT_VERSION'] ?? '1.0',
        },
      });
      const ctx: ConnectorContext = {
        now: () => new Date(),
        userPresent: true,
        logger: createLogger({ level: 'silent' }),
      };
      const config = { bank: bank ?? '', userId: userId ?? '', pin: pin ?? '' };
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

        const accounts = await connector.listAccounts(step.state, ctx, config);
        say(formatAccounts(accounts));
        const checking = accounts.find((a) => a.kind === 'checking');
        expect(checking, 'no checking account').toBeDefined();

        const since = new Date(Date.now() - 30 * 86_400_000);
        const result = await connector.fetchTransactions(
          step.state,
          checking?.ref ?? '',
          since,
          ctx,
          config,
        );
        expect(result.ok, 'fetch failed').toBe(true);
        if (result.ok) say(formatTransactionSummary(result.transactions));
      } finally {
        dialogs.clear();
      }
    },
    10 * 60_000,
  );
});

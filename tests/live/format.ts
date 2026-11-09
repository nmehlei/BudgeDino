import type {
  Challenge,
  ProviderAccount,
  ProviderTransaction,
} from '@budgedino/server/connectors/types';

/**
 * Output of the live FinTS test. It receives real bank data, so every formatter whitelists the few
 * fields that may be printed (challenge kind and message, account kinds, counts, booking dates) and
 * never touches amounts, names, IBANs, references or credentials.
 */

export function formatChallenge(c: Challenge): string {
  switch (c.kind) {
    case 'decoupled':
    case 'code':
    case 'image':
      return `challenge: kind=${c.kind} message=${JSON.stringify(c.message)}`;
    case 'redirect':
      return 'challenge: kind=redirect';
  }
}

export function formatAccounts(accounts: readonly ProviderAccount[]): string {
  const kinds = accounts.map((a) => a.kind).sort();
  return `accounts: ${accounts.length} [${kinds.join(', ')}]`;
}

export function formatTransactionSummary(txs: readonly ProviderTransaction[]): string {
  if (txs.length === 0) return 'transactions: 0';
  const dates = txs.map((t) => t.bookingDate).sort();
  return `transactions: ${txs.length}, booking dates ${dates[0]} .. ${dates[dates.length - 1]}`;
}

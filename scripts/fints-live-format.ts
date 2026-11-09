import type {
  Challenge,
  ConnectorState,
  ProviderAccount,
  ProviderTransaction,
} from '../src/server/src/connectors/types.js';

/**
 * Output of the live FinTS script (`pnpm fints:live`). It receives real bank data, so every formatter whitelists the few
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

/**
 * Whether the selected TAN method needs a TAN medium and how many media are active (a count, never
 * names). Read from the connector state's banking information.
 */
export function formatTanMedia(state: ConnectorState): string {
  const bpd = (state['bankingInformation'] as { bpd?: { supportedTanMethods?: unknown } } | null)
    ?.bpd;
  const methods = Array.isArray(bpd?.supportedTanMethods)
    ? (bpd.supportedTanMethods as {
        id?: unknown;
        tanMediaRequirement?: unknown;
        activeTanMedia?: unknown;
      }[])
    : [];
  const m = methods.find((x) => x.id === state['tanMethodId']);
  if (!m) return 'tan medium: unknown';
  const requirement =
    m.tanMediaRequirement === 2 ? 'required' : m.tanMediaRequirement === 1 ? 'optional' : 'no';
  const active = Array.isArray(m.activeTanMedia) ? m.activeTanMedia.length : 0;
  return `tan medium: ${requirement}, active media ${active}`;
}

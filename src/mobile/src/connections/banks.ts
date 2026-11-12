import type { ConnectorInfo } from '@budgedino/shared';

/** Banks the FinTS connector supports. Keep in sync with `FINTS_BANKS` in the server catalog. */
export const FINTS_BANK_CHOICES = [
  { id: 'dkb', name: 'DKB' },
  { id: 'comdirect', name: 'Comdirect' },
] as const;

export type FinTSBankChoice = (typeof FINTS_BANK_CHOICES)[number]['id'];

/** Human label for a connector type (used when a connection has no bank id of its own). */
export function connectorTypeLabel(type: string): string {
  switch (type) {
    case 'fints':
      return 'Bank (FinTS)';
    case 'fake':
      return 'Demo bank';
    default:
      return type;
  }
}

interface BankBrand {
  name: string;
  initials: string;
  /** Brand colours of the monogram fallback; the only non-theme colours in the app. */
  background?: string;
  foreground?: string;
}

const BANK_BRANDS: Record<string, BankBrand> = {
  dkb: { name: 'DKB', initials: 'DKB', background: '#1F5DA8', foreground: '#FFFFFF' },
  comdirect: { name: 'Comdirect', initials: 'CD', background: '#FFD500', foreground: '#1A1A1A' },
  fake: { name: 'Demo bank', initials: 'DB' },
};

/** Name of a bank id (`dkb`, `comdirect`, `fake`); other ids fall back to the connector type label. */
export function bankName(bank: string): string {
  return Object.hasOwn(BANK_BRANDS, bank)
    ? (BANK_BRANDS[bank]?.name ?? connectorTypeLabel(bank))
    : connectorTypeLabel(bank);
}

/** Monogram letters and optional brand colours of a bank id. */
export function bankBrand(bank: string): Omit<BankBrand, 'name'> {
  const known = Object.hasOwn(BANK_BRANDS, bank) ? BANK_BRANDS[bank] : undefined;
  if (known) return known;
  const words = bankName(bank)
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const initials =
    words.length > 1
      ? words
          .slice(0, 2)
          .map((w) => w.charAt(0))
          .join('')
      : (words[0] ?? '').slice(0, 2);
  return { initials: initials.toUpperCase() };
}

/** What a connection is called in lists and chips: the user's name (own connections only), else the bank. */
export function connectorTitle(c: ConnectorInfo): string {
  const custom = c.isOwner ? c.displayName?.trim() : undefined;
  return custom ? custom : bankName(c.bank);
}

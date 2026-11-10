/** Banks the FinTS connector supports. Keep in sync with `FINTS_BANKS` in the server catalog. */
export const FINTS_BANK_CHOICES = [
  { id: 'dkb', name: 'DKB' },
  { id: 'comdirect', name: 'Comdirect' },
] as const;

export type FinTSBankChoice = (typeof FINTS_BANK_CHOICES)[number]['id'];

/** Human label for a connector type (the list API reports the type, not the bank). */
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

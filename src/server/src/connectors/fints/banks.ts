export type FinTSBankId = 'dkb' | 'comdirect';

/**
 * Supported banks. Values checked against published sources (2026-11-09):
 * - DKB: BLZ 12030000; endpoint https://fints.dkb.de/fints (the old banking-dkb.s-fints-pt-dkb.de
 *   address was retired 2024-11-25), see https://www.teltarif.de/arch/2024/kw47/s97127.html
 * - Comdirect: BLZ 20041111; endpoint https://fints.comdirect.de/fints, as used in a working
 *   AqBanking setup (https://www.aquamaniac.de/rdm/issues/126). The full institute list is at
 *   https://www.hbci-zka.de/ (fints.org).
 */
export const FINTS_BANKS: Record<
  FinTSBankId,
  { name: string; blz: string; url: string; iconUrl: string }
> = {
  dkb: {
    name: 'DKB',
    blz: '12030000',
    url: 'https://fints.dkb.de/fints',
    // iconUrl: the bank's own apple-touch-icon on its official domain, fetched lazily by the server
    // (bank-icons.ts); no logo files live in the repo. It is the only place an icon URL may come from.
    iconUrl: 'https://www.dkb.de/apple-touch-icon.png',
  },
  comdirect: {
    name: 'Comdirect',
    blz: '20041111',
    url: 'https://fints.comdirect.de/fints',
    iconUrl: 'https://www.comdirect.de/apple-touch-icon.png',
  },
};

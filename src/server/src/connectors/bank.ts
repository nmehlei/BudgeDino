import type { ConnectorConfig } from './types.js';
import { FINTS_BANKS } from './fints/banks.js';

/**
 * The non-secret bank id of a connector: the FinTS `bank` of its config (`dkb`, `comdirect`), otherwise the
 * connector type (`fake`). Stored plaintext in `connectors.bank` at create time.
 */
export function bankIdFor(type: string, config: ConnectorConfig): string {
  if (type === 'fints') {
    const bank = config['bank'];
    if (typeof bank === 'string' && Object.hasOwn(FINTS_BANKS, bank)) return bank;
  }
  return type;
}

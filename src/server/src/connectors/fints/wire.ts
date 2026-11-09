import type { Logger } from '../../observability/logger.js';
import type { Connector } from '../types.js';
import { createFinTSConnector } from './connector.js';
import { FinTSDialogRegistry } from './dialogs.js';
import { LibFintsPort } from './lib-fints-port.js';
import type { FinTSPort } from './port.js';

export interface FinTSWiringOptions {
  product: { id: string; version: string };
  logger: Logger;
  now?: () => Date;
  /** Test seam; default: the real lib-fints port. */
  port?: FinTSPort;
  sweepIntervalMs?: number;
}

export interface FinTSWiring {
  connector: Connector;
  dialogs: FinTSDialogRegistry;
  /** Stops the sweep timer and drops every open dialog (and its credentials). */
  stop(): void;
}

/**
 * Production wiring: one process-wide dialog registry (swept every 60 s by an unref'd timer) and one
 * lib-fints port. A BPD/catalog URL mismatch is logged with the BLZ only.
 */
export function createFinTSWiring(opts: FinTSWiringOptions): FinTSWiring {
  const now = opts.now ?? (() => new Date());
  const dialogs = new FinTSDialogRegistry({ now });
  const port =
    opts.port ??
    new LibFintsPort({
      onUrlMismatch: (blz) =>
        opts.logger.warn({ blz }, 'fints: bank-announced URL differs from catalog; using catalog'),
    });
  const timer = setInterval(() => dialogs.sweep(), opts.sweepIntervalMs ?? 60_000);
  timer.unref();
  const connector = createFinTSConnector({ port, dialogs, product: opts.product });
  return {
    connector,
    dialogs,
    stop: () => {
      clearInterval(timer);
      dialogs.clear();
    },
  };
}

import { eq, isNull } from 'drizzle-orm';
import { decryptString } from '../crypto/index.js';
import type { Db } from '../db/client.js';
import { connectors } from '../db/schema.js';
import type { Keyring } from '../households/keyring.js';
import type { Logger } from '../observability/logger.js';
import { safeErrorInfo } from '../observability/redact.js';
import { bankIdFor } from './bank.js';
import type { ConnectorConfig } from './types.js';

/**
 * One-time startup step after the SQL migrations: connectors created before `connectors.bank` existed keep
 * the bank only inside their encrypted config, so decrypt it once and write the plaintext id. Rows that cannot
 * be decrypted or name an unknown bank get the connector type as bank (so they are not rescanned on every
 * startup) and never block startup. Returns the rows filled.
 */
export async function backfillConnectorBanks(
  db: Db,
  keyring: Keyring,
  logger: Logger,
): Promise<number> {
  const rows = await db
    .select({
      id: connectors.id,
      type: connectors.type,
      householdId: connectors.householdId,
      configEnc: connectors.configEnc,
    })
    .from(connectors)
    .where(isNull(connectors.bank));
  let filled = 0;
  for (const row of rows) {
    try {
      // Database/keyring failures are transient: skip the row and retry on the next start.
      const dk = await keyring.forHousehold(row.householdId);
      let bank: string;
      let decrypted = true;
      try {
        const config = JSON.parse(
          decryptString(dk, row.configEnc, {
            table: 'connectors',
            column: 'config',
            rowId: row.id,
          }),
        ) as ConnectorConfig;
        bank = bankIdFor(row.type, config);
      } catch (err) {
        // Only an undecryptable or unparsable config falls back for good: the connector type is the
        // bank, so the row is not rescanned on every startup.
        logger.warn({ connectorId: row.id, error: safeErrorInfo(err) }, 'bank backfill: fallback');
        bank = row.type;
        decrypted = false;
      }
      await db.update(connectors).set({ bank }).where(eq(connectors.id, row.id));
      if (decrypted) filled += 1;
    } catch (err) {
      logger.warn({ connectorId: row.id, error: safeErrorInfo(err) }, 'bank backfill: skipped');
    }
  }
  return filled;
}

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
 * be decrypted are left null (they read as their type) and never block startup. Returns the rows filled.
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
      const dk = await keyring.forHousehold(row.householdId);
      const config = JSON.parse(
        decryptString(dk, row.configEnc, { table: 'connectors', column: 'config', rowId: row.id }),
      ) as ConnectorConfig;
      await db
        .update(connectors)
        .set({ bank: bankIdFor(row.type, config) })
        .where(eq(connectors.id, row.id));
      filled += 1;
    } catch (err) {
      logger.warn({ connectorId: row.id, error: safeErrorInfo(err) }, 'bank backfill: skipped');
    }
  }
  return filled;
}

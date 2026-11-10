import { and, eq, inArray } from 'drizzle-orm';
import type { DeleteConnectorQuery } from '@budgedino/shared';
import { accounts, challenges, connectors } from '../db/schema.js';
import type { AuthContext } from '../deps.js';
import { HttpError } from '../http/errors.js';
import { encryptDisplayName } from '../repositories/connectors.js';
import { withConnectorLock } from '../sync/run.js';
import { closeChallenge, type ChallengeDeps } from './challenge-service.js';

export type DeleteMode = DeleteConnectorQuery['mode'];

export interface ConnectorManager {
  /**
   * Removes a connector the caller owns (404 for anyone else). `keep` leaves its accounts (disconnected) and
   * their data; `purge` deletes them too. Waits for a running sync of the connector (its advisory lock), so a
   * sync never writes into rows that are being removed.
   */
  remove(auth: AuthContext, connectorId: string, mode: DeleteMode): Promise<void>;
  /** Sets (or with `null` clears) the encrypted display name of an own connector. */
  rename(auth: AuthContext, connectorId: string, displayName: string | null): Promise<void>;
}

const notFound = () => new HttpError(404, 'not_found', 'Connector not found');

export function createConnectorManager(deps: ChallengeDeps): ConnectorManager {
  const { db } = deps;

  async function loadOwned(auth: AuthContext, id: string) {
    const [row] = await db
      .select()
      .from(connectors)
      .where(
        and(
          eq(connectors.id, id),
          eq(connectors.ownerMemberId, auth.memberId),
          eq(connectors.householdId, auth.householdId),
        ),
      );
    if (!row) throw notFound();
    return row;
  }

  return {
    async remove(auth, connectorId, mode) {
      const connector = await loadOwned(auth, connectorId);
      // End open bank dialogs first (best-effort cancelAuth); the rows go with the connector below.
      const open = await db
        .select()
        .from(challenges)
        .where(
          and(
            eq(challenges.connectorId, connectorId),
            inArray(challenges.status, ['open', 'answering']),
          ),
        );
      for (const row of open) {
        await closeChallenge(deps, row, connector, 'cancelled', ['open', 'answering']);
      }
      await withConnectorLock(deps, connectorId, async () => {
        await db.transaction(async (tx) => {
          if (mode === 'purge') {
            // transactions, splits and dedup aliases cascade from the account
            await tx.delete(accounts).where(eq(accounts.connectorId, connectorId));
          } else {
            await tx
              .update(accounts)
              .set({ connectorId: null, disconnectedAt: deps.now() })
              .where(eq(accounts.connectorId, connectorId));
          }
          // credentials, state, challenges and sync runs cascade from the connector
          const deleted = await tx
            .delete(connectors)
            .where(eq(connectors.id, connectorId))
            .returning({ id: connectors.id });
          if (deleted.length === 0) throw notFound(); // a concurrent delete won
        });
      });
    },

    async rename(auth, connectorId, displayName) {
      await loadOwned(auth, connectorId);
      const dk = await deps.keyring.forHousehold(auth.householdId);
      const updated = await db
        .update(connectors)
        .set({
          displayNameEnc:
            displayName === null ? null : encryptDisplayName(dk, connectorId, displayName),
        })
        .where(and(eq(connectors.id, connectorId), eq(connectors.ownerMemberId, auth.memberId)))
        .returning({ id: connectors.id });
      if (updated.length === 0) throw notFound();
    },
  };
}

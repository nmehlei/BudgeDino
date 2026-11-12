import { and, eq, inArray, isNotNull, notInArray } from 'drizzle-orm';
import type { DeleteConnectorQuery } from '@budgedino/shared';
import { accounts, categories, challenges, connectors, transactions } from '../db/schema.js';
import type { AuthContext } from '../deps.js';
import { HttpError } from '../http/errors.js';
import { encryptDisplayName } from '../repositories/connectors.js';
import { withConnectorLock } from '../sync/run.js';
import { safeErrorInfo } from '../observability/redact.js';
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

type Tx = Parameters<Parameters<ChallengeDeps['db']['transaction']>[0]>[0];

/**
 * Before a purge deletes a connector's accounts: the surviving halves of transfer pairs that reach into those
 * accounts lose their `transfer_group_id` (otherwise they stay excluded from budgets and can never be paired
 * again). A non-manual Transfer category set by the pairing is reset so categorization can run again.
 * Returns the ids of the released rows.
 */
async function releaseTransferPartners(
  tx: Tx,
  householdId: string,
  connectorId: string,
): Promise<string[]> {
  const purged = tx
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.connectorId, connectorId));
  const groups = await tx
    .selectDistinct({ group: transactions.transferGroupId })
    .from(transactions)
    .where(and(isNotNull(transactions.transferGroupId), inArray(transactions.accountId, purged)));
  const groupIds = groups.map((g) => g.group).filter((g): g is string => g !== null);
  if (groupIds.length === 0) return [];
  const released = await tx
    .update(transactions)
    .set({ transferGroupId: null })
    .where(
      and(
        inArray(transactions.transferGroupId, groupIds),
        notInArray(transactions.accountId, purged),
      ),
    )
    .returning({ id: transactions.id });
  const ids = released.map((r) => r.id);
  if (ids.length > 0) {
    const transferCategories = tx
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.householdId, householdId), eq(categories.isTransfer, true)));
    await tx
      .update(transactions)
      .set({ categoryId: null, categorySource: 'none', categorySetAt: null })
      .where(
        and(
          inArray(transactions.id, ids),
          inArray(transactions.categoryId, transferCategories),
          inArray(transactions.categorySource, ['rule', 'learned', 'heuristic']),
        ),
      );
  }
  return ids;
}

const notFound = () => new HttpError(404, 'not_found', 'Connector not found');

export interface ConnectorManagerDeps extends ChallengeDeps {
  /** The post-ingest hook (categorize, detect transfers, alerts); re-run for rows a purge un-paired. */
  onIngested?: (householdId: string, txIds: string[]) => Promise<void>;
}

export function createConnectorManager(deps: ConnectorManagerDeps): ConnectorManager {
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
      let unpaired: string[] = [];
      await withConnectorLock(deps, connectorId, async () => {
        await db.transaction(async (tx) => {
          if (mode === 'purge') {
            unpaired = await releaseTransferPartners(tx, connector.householdId, connectorId);
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
      if (unpaired.length > 0 && deps.onIngested) {
        // Best effort: the purge is done; a failure here only leaves the rows to the next detection.
        try {
          await deps.onIngested(connector.householdId, unpaired);
        } catch (err) {
          deps.logger.error({ connectorId, error: safeErrorInfo(err) }, 'purge: re-pairing failed');
        }
      }
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

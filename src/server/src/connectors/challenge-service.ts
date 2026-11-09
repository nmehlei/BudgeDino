import { and, eq, inArray, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ChallengeAnswer, ChallengeStatus, ChallengeView } from '@budgedino/shared';
import { blindIndex, decryptString, encryptField, type DataKey } from '../crypto/index.js';
import type { Db } from '../db/client.js';
import { newId } from '../db/ids.js';
import { accounts, challenges, connectors } from '../db/schema.js';
import type { AuthContext } from '../deps.js';
import type { Keyring } from '../households/keyring.js';
import { HttpError } from '../http/errors.js';
import type { Logger } from '../observability/logger.js';
import { safeErrorInfo } from '../observability/redact.js';
import { createAccount } from '../repositories/accounts.js';
import { encryptConnectorState } from '../repositories/connectors.js';
import type { SyncService } from '../sync/service.js';
import { UnknownConnectorError, type ConnectorRegistry } from './registry.js';
import {
  ConnectorAuthError,
  InvalidAnswerError,
  type AuthStep,
  type Challenge,
  type ConnectorConfig,
  type ConnectorContext,
  type ConnectorState,
  type DialogState,
} from './types.js';

/** A challenge (and the bank dialog behind it) lives at most this long. */
export const CHALLENGE_TTL_MS = 10 * 60 * 1000;
/** The N-th invalid answer ends the challenge. */
export const MAX_INVALID_ANSWERS = 5;
/** Renewals (not-done steps) never stretch a challenge beyond this age. */
export const CHALLENGE_MAX_LIFETIME_MS = 15 * 60 * 1000;
/** An `answering` claim is considered abandoned (crashed process) this long after its expiry. */
export const ANSWERING_GRACE_MS = 2 * 60 * 1000;

type ChallengeRow = typeof challenges.$inferSelect;
type ConnectorRow = typeof connectors.$inferSelect;
type DbStatus = ChallengeRow['status'];

export interface ChallengeDeps {
  db: Db;
  keyring: Keyring;
  registry: ConnectorRegistry;
  logger: Logger;
  now: () => Date;
}

/**
 * What `challenges.payload_enc` holds (one encrypted JSON envelope per row): the public challenge, the
 * bank dialog state (server-side only, never in a response) and the per-challenge counters.
 */
export interface ChallengeEnvelope {
  challenge: Challenge;
  dialog: DialogState;
  invalidAnswers: number;
  /** ISO time of the last bank call (enforces `pollAfterMs` for decoupled challenges). */
  lastPollAt: string | null;
}

const payloadAad = (rowId: string) => ({ table: 'challenges', column: 'payload', rowId });
const configAad = (rowId: string) => ({ table: 'connectors', column: 'config', rowId });

export function sealEnvelope(dk: DataKey, rowId: string, envelope: ChallengeEnvelope): Buffer {
  return encryptField(dk, JSON.stringify(envelope), payloadAad(rowId));
}
function openEnvelope(dk: DataKey, rowId: string, enc: Buffer): ChallengeEnvelope {
  return JSON.parse(decryptString(dk, enc, payloadAad(rowId))) as ChallengeEnvelope;
}

const publicStatus = (s: DbStatus): ChallengeStatus => {
  switch (s) {
    case 'completed':
      return 'completed';
    case 'cancelled':
      return 'cancelled';
    case 'expired':
      return 'expired';
    default:
      return 'open'; // open, answering, answered
  }
};

const view = (id: string, expiresAt: Date, challenge: Challenge): ChallengeView => ({
  ...challenge,
  id,
  expiresAt: expiresAt.toISOString(),
});

const ttlFor = (now: Date, step: { expiresAt?: Date | undefined }, createdAt: Date = now): Date => {
  const cap = Math.min(
    now.getTime() + CHALLENGE_TTL_MS,
    createdAt.getTime() + CHALLENGE_MAX_LIFETIME_MS,
  );
  return step.expiresAt && step.expiresAt.getTime() < cap ? step.expiresAt : new Date(cap);
};

/** Open challenges expire at `expiresAt`; an `answering` one only after the grace period. */
const isStale = (row: Pick<ChallengeRow, 'status' | 'expiresAt'>, now: Date): boolean =>
  (row.status === 'open' && row.expiresAt.getTime() <= now.getTime()) ||
  (row.status === 'answering' && row.expiresAt.getTime() + ANSWERING_GRACE_MS <= now.getTime());

const notFound = () => new HttpError(404, 'not_found', 'Not found');
const busy = () =>
  new HttpError(409, 'challenge_busy', 'This challenge is being answered right now');
const unavailable = () =>
  new HttpError(502, 'connector_unavailable', 'The bank could not be reached, try again later');

const FALLBACK_CONFIG = z.record(z.string(), z.json());

/** Ends a challenge's bank dialog early; never throws. */
async function cancelDialog(
  deps: ChallengeDeps,
  row: Pick<ChallengeRow, 'id' | 'payloadEnc'>,
  connector: Pick<ConnectorRow, 'id' | 'type' | 'householdId'>,
  userPresent: boolean,
): Promise<void> {
  try {
    const impl = deps.registry.get(connector.type);
    if (!impl.cancelAuth) return;
    const dk = await deps.keyring.forHousehold(connector.householdId);
    const envelope = openEnvelope(dk, row.id, row.payloadEnc);
    await impl.cancelAuth(envelope.dialog, {
      now: deps.now,
      userPresent,
      logger: deps.logger,
    });
  } catch (err) {
    deps.logger.warn(
      { connectorId: connector.id, error: safeErrorInfo(err) },
      'challenge: cancelAuth failed',
    );
  }
}

/** Conditionally moves a challenge to `to` and, when it did, cancels the bank dialog. */
async function closeChallenge(
  deps: ChallengeDeps,
  row: ChallengeRow,
  connector: Pick<ConnectorRow, 'id' | 'type' | 'householdId'>,
  to: 'cancelled' | 'expired',
  from: DbStatus[],
  userPresent = true,
): Promise<boolean> {
  const [updated] = await deps.db
    .update(challenges)
    .set({ status: to })
    .where(and(eq(challenges.id, row.id), inArray(challenges.status, from)))
    .returning({ id: challenges.id });
  if (!updated) return false;
  await cancelDialog(deps, row, connector, userPresent);
  return true;
}

/**
 * Expires every open or stale `answering` challenge past its TTL (pg-boss job `challenges.expire`, every
 * minute; the same check also runs lazily on each challenge request). The connector stays `needs_attention`.
 * Returns how many challenges it expired.
 */
export async function expireChallenges(deps: ChallengeDeps): Promise<number> {
  const now = deps.now();
  const due = await deps.db
    .select({
      challenge: challenges,
      connector: { id: connectors.id, type: connectors.type, householdId: connectors.householdId },
    })
    .from(challenges)
    .innerJoin(connectors, eq(challenges.connectorId, connectors.id))
    .where(
      or(
        and(eq(challenges.status, 'open'), lte(challenges.expiresAt, now)),
        and(
          eq(challenges.status, 'answering'),
          lte(challenges.expiresAt, new Date(now.getTime() - ANSWERING_GRACE_MS)),
        ),
      ),
    );
  let expired = 0;
  for (const { challenge, connector } of due) {
    // no user is present: the sweeper acts on its own
    if (await closeChallenge(deps, challenge, connector, 'expired', [challenge.status], false)) {
      expired += 1;
    }
  }
  return expired;
}

export interface ChallengeService {
  connect(
    auth: AuthContext,
    input: { type: string; config: Record<string, unknown> },
    psuIp: string | undefined,
  ): Promise<{ connectorId: string; challenge?: ChallengeView }>;
  reconnect(
    auth: AuthContext,
    connectorId: string,
    psuIp: string | undefined,
  ): Promise<{ challenge?: ChallengeView }>;
  answer(
    auth: AuthContext,
    challengeId: string,
    answer: ChallengeAnswer,
    psuIp: string | undefined,
  ): Promise<{ status: ChallengeStatus; reason?: string; challenge?: ChallengeView }>;
  status(auth: AuthContext, challengeId: string): Promise<{ status: ChallengeStatus }>;
  cancel(auth: AuthContext, challengeId: string): Promise<{ status: ChallengeStatus }>;
}

export function createChallengeService(
  deps: ChallengeDeps & { sync: Pick<SyncService, 'startUserRun'> },
): ChallengeService {
  const { db, registry, logger } = deps;
  const ctxFor = (psuIp: string | undefined): ConnectorContext => ({
    now: deps.now,
    userPresent: true,
    ...(psuIp === undefined ? {} : { psuIp }),
    logger,
  });

  /** The caller's own challenge (404 for anyone else), with the lazy TTL check applied. */
  async function loadOwned(
    auth: AuthContext,
    id: string,
  ): Promise<{ row: ChallengeRow; connector: ConnectorRow }> {
    const find = async () => {
      const [found] = await db
        .select({ row: challenges, connector: connectors })
        .from(challenges)
        .innerJoin(connectors, eq(challenges.connectorId, connectors.id))
        .where(
          and(
            eq(challenges.id, id),
            eq(challenges.memberId, auth.memberId),
            eq(connectors.ownerMemberId, auth.memberId),
            eq(connectors.householdId, auth.householdId),
          ),
        );
      return found;
    };
    const found = await find();
    if (!found) throw notFound();
    if (isStale(found.row, deps.now())) {
      await closeChallenge(deps, found.row, found.connector, 'expired', [found.row.status]);
      return (await find()) ?? Promise.reject(notFound());
    }
    return found;
  }

  /**
   * Cancels every open challenge of the connector (at most one may be open) and, in the same
   * serialised step, optionally inserts the new one. The bank-side cancel runs after commit.
   */
  async function swapChallenge(
    connector: ConnectorRow,
    insert: typeof challenges.$inferInsert | null,
  ): Promise<void> {
    const superseded = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`challenge-swap:${connector.id}`}, 0))`,
      );
      const old = await tx
        .select()
        .from(challenges)
        .where(
          and(
            eq(challenges.connectorId, connector.id),
            inArray(challenges.status, ['open', 'answering']),
          ),
        );
      if (old.length > 0) {
        await tx
          .update(challenges)
          .set({ status: 'cancelled' })
          .where(
            inArray(
              challenges.id,
              old.map((o) => o.id),
            ),
          );
      }
      if (insert) await tx.insert(challenges).values(insert);
      return old;
    });
    for (const old of superseded) await cancelDialog(deps, old, connector, true);
  }

  async function discoverAccounts(connector: ConnectorRow, state: ConnectorState, psuIp?: string) {
    const dk = await deps.keyring.forHousehold(connector.householdId);
    const provided = await registry.get(connector.type).listAccounts(state, ctxFor(psuIp));
    for (const p of provided) {
      const bidx = blindIndex(dk, 'account-external-ref', p.ref);
      const [existing] = await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(and(eq(accounts.connectorId, connector.id), eq(accounts.externalRefBidx, bidx)));
      if (existing) continue;
      await createAccount(db, dk, {
        connectorId: connector.id,
        ownerMemberId: connector.ownerMemberId,
        externalRef: p.ref,
        name: p.name,
        ...(p.iban === undefined ? {} : { iban: p.iban }),
        kind: p.kind,
        currency: p.currency,
        visibility: 'household',
        countsTowardBudgets: true,
      });
    }
  }

  /** After a successful auth: account discovery, then a user-present sync. Neither can fail the connect. */
  async function afterConnected(connector: ConnectorRow, state: ConnectorState, psuIp?: string) {
    try {
      await discoverAccounts(connector, state, psuIp);
    } catch (err) {
      logger.error(
        { connectorId: connector.id, error: safeErrorInfo(err) },
        'account discovery failed',
      );
    }
    try {
      await deps.sync.startUserRun(connector.id, psuIp, { followUpIfSuperseded: true });
    } catch (err) {
      if (err instanceof HttpError && err.statusCode === 429) return; // throttled: a recent run exists
      logger.error(
        { connectorId: connector.id, error: safeErrorInfo(err) },
        'post-connect sync failed',
      );
    }
  }

  const connectedValues = async (
    connector: ConnectorRow,
    step: Extract<AuthStep, { done: true }>,
  ) => {
    const dk = await deps.keyring.forHousehold(connector.householdId);
    return {
      stateEnc: encryptConnectorState(dk, connector.id, step.state),
      status: 'ok' as const,
      consentExpiresAt: step.consentExpiresAt ?? null,
      lastErrorCode: null,
      stateGeneration: sql`${connectors.stateGeneration} + 1`,
    };
  };

  /** Starts the bank dialog of a connector; resolves with the challenge the user must answer, if any. */
  async function begin(
    connector: ConnectorRow,
    config: ConnectorConfig,
    psuIp: string | undefined,
  ): Promise<ChallengeView | undefined> {
    await swapChallenge(connector, null);
    let step: AuthStep;
    try {
      step = await registry.get(connector.type).startAuth(config, ctxFor(psuIp));
    } catch (err) {
      logger.warn({ connectorId: connector.id, error: safeErrorInfo(err) }, 'startAuth failed');
      if (err instanceof ConnectorAuthError) {
        throw new HttpError(409, 'connector_auth_failed', 'The bank refused the connection');
      }
      throw unavailable();
    }
    if (step.done) {
      const values = await connectedValues(connector, step);
      await db.update(connectors).set(values).where(eq(connectors.id, connector.id));
      await afterConnected(connector, step.state, psuIp);
      return undefined;
    }
    const id = newId();
    const dk = await deps.keyring.forHousehold(connector.householdId);
    const expiresAt = ttlFor(deps.now(), step);
    await swapChallenge(connector, {
      id,
      connectorId: connector.id,
      memberId: connector.ownerMemberId,
      kind: step.challenge.kind,
      payloadEnc: sealEnvelope(dk, id, {
        challenge: step.challenge,
        dialog: step.dialog,
        invalidAnswers: 0,
        // the first poll of a decoupled challenge waits pollAfterMs, too
        lastPollAt: step.challenge.kind === 'decoupled' ? deps.now().toISOString() : null,
      }),
      status: 'open',
      expiresAt,
      createdAt: deps.now(),
    });
    return view(id, expiresAt, step.challenge);
  }

  async function currentStatus(id: string): Promise<ChallengeStatus> {
    const [row] = await db
      .select({ status: challenges.status })
      .from(challenges)
      .where(eq(challenges.id, id));
    return row ? publicStatus(row.status) : 'cancelled';
  }

  return {
    async connect(auth, input, psuIp) {
      let impl;
      try {
        impl = registry.get(input.type);
      } catch (err) {
        if (err instanceof UnknownConnectorError) {
          throw new HttpError(400, 'unknown_connector_type', 'Unknown connector type');
        }
        throw err;
      }
      const parsed = (impl.configSchema ?? FALLBACK_CONFIG).safeParse(input.config);
      if (!parsed.success) {
        throw new HttpError(400, 'invalid_config', 'The connector configuration is invalid');
      }
      const config = parsed.data as ConnectorConfig;
      const dk = await deps.keyring.forHousehold(auth.householdId);
      const id = newId();
      const [connector] = await db
        .insert(connectors)
        .values({
          id,
          householdId: auth.householdId,
          ownerMemberId: auth.memberId,
          type: input.type,
          status: 'needs_attention',
          configEnc: encryptField(dk, JSON.stringify(config), configAad(id)),
        })
        .returning();
      if (!connector) throw new Error('connector insert returned no row');
      try {
        const challenge = await begin(connector, config, psuIp);
        return { connectorId: id, ...(challenge ? { challenge } : {}) };
      } catch (err) {
        // The client never learns this id: do not leave a credential-bearing orphan behind.
        await db
          .delete(connectors)
          .where(eq(connectors.id, id))
          .catch((delErr: unknown) =>
            logger.error(
              { connectorId: id, error: safeErrorInfo(delErr) },
              'could not remove failed connector',
            ),
          );
        throw err;
      }
    },

    async reconnect(auth, connectorId, psuIp) {
      const [connector] = await db
        .select()
        .from(connectors)
        .where(
          and(
            eq(connectors.id, connectorId),
            eq(connectors.ownerMemberId, auth.memberId),
            eq(connectors.householdId, auth.householdId),
          ),
        );
      if (!connector) throw notFound();
      const dk = await deps.keyring.forHousehold(connector.householdId);
      const config = JSON.parse(
        decryptString(dk, connector.configEnc, configAad(connector.id)),
      ) as ConnectorConfig;
      const challenge = await begin(connector, config, psuIp);
      return challenge ? { challenge } : {};
    },

    async status(auth, challengeId) {
      const { row } = await loadOwned(auth, challengeId);
      return { status: publicStatus(row.status) };
    },

    async cancel(auth, challengeId) {
      const { row, connector } = await loadOwned(auth, challengeId);
      if (row.status === 'answering') throw busy();
      if (row.status === 'open') {
        await closeChallenge(deps, row, connector, 'cancelled', ['open']);
      }
      return { status: await currentStatus(row.id) };
    },

    async answer(auth, challengeId, answer, psuIp) {
      const { row: loaded, connector } = await loadOwned(auth, challengeId);
      if (loaded.status === 'answering') throw busy();
      if (loaded.status !== 'open') return { status: publicStatus(loaded.status) };

      // Claim: only one answer at a time reaches the bank; no DB transaction spans that call.
      const [row] = await db
        .update(challenges)
        .set({ status: 'answering' })
        .where(and(eq(challenges.id, loaded.id), eq(challenges.status, 'open')))
        .returning();
      if (!row) {
        const status = await currentStatus(loaded.id);
        if (status === 'open') throw busy();
        return { status };
      }

      /** Writes the result only while we still hold the claim (the sweeper or a cancel may have won). */
      const settle = async (set: Partial<typeof challenges.$inferInsert>): Promise<boolean> => {
        const [updated] = await db
          .update(challenges)
          .set(set)
          .where(and(eq(challenges.id, row.id), eq(challenges.status, 'answering')))
          .returning({ id: challenges.id });
        return updated !== undefined;
      };
      const release = () => settle({ status: 'open' });

      const dk = await deps.keyring.forHousehold(connector.householdId);
      const envelope = openEnvelope(dk, row.id, row.payloadEnc);
      const now = deps.now();

      if (envelope.challenge.kind === 'decoupled' && envelope.lastPollAt !== null) {
        const waitMs =
          new Date(envelope.lastPollAt).getTime() + envelope.challenge.pollAfterMs - now.getTime();
        if (waitMs > 0) {
          await release();
          throw new HttpError(429, 'poll_too_early', 'Poll again later', {
            'retry-after': String(Math.ceil(waitMs / 1000)),
          });
        }
      }

      let step: AuthStep;
      try {
        step = await registry
          .get(connector.type)
          .continueAuth(envelope.dialog, answer, ctxFor(psuIp));
      } catch (err) {
        if (err instanceof InvalidAnswerError) {
          const invalidAnswers = envelope.invalidAnswers + 1;
          if (invalidAnswers >= MAX_INVALID_ANSWERS) {
            if (await closeChallenge(deps, row, connector, 'cancelled', ['answering'])) {
              return { status: 'cancelled', reason: 'too_many_invalid_answers' };
            }
            return { status: await currentStatus(row.id) };
          }
          await settle({
            status: 'open',
            payloadEnc: sealEnvelope(dk, row.id, {
              ...envelope,
              invalidAnswers,
              lastPollAt: now.toISOString(),
            }),
          });
          throw new HttpError(422, 'invalid_answer', 'The answer was not accepted');
        }
        if (err instanceof ConnectorAuthError) {
          // The dialog is over on the bank side: nothing left to cancel.
          const to = err.reason === 'timeout' ? 'expired' : 'cancelled';
          if (await settle({ status: to })) return { status: to, reason: err.reason };
          return { status: await currentStatus(row.id) };
        }
        logger.error(
          { connectorId: connector.id, error: safeErrorInfo(err) },
          'continueAuth failed',
        );
        await release();
        throw unavailable();
      }

      if (step.done) {
        const values = await connectedValues(connector, step);
        // One atomic write that bumps `state_generation`: a sync run that started earlier sees the change and
        // no longer writes state or status (no lock wait, the user's answer never blocks behind a sync).
        const won = await db.transaction(async (tx) => {
          const [updated] = await tx
            .update(challenges)
            .set({ status: 'completed' })
            .where(and(eq(challenges.id, row.id), eq(challenges.status, 'answering')))
            .returning({ id: challenges.id });
          if (!updated) return false;
          await tx.update(connectors).set(values).where(eq(connectors.id, connector.id));
          return true;
        });
        if (!won) return { status: await currentStatus(row.id) };
        await afterConnected(connector, step.state, psuIp);
        return { status: 'completed' };
      }

      const expiresAt = ttlFor(now, step, row.createdAt);
      const kept = await settle({
        status: 'open',
        kind: step.challenge.kind,
        expiresAt,
        payloadEnc: sealEnvelope(dk, row.id, {
          challenge: step.challenge,
          dialog: step.dialog,
          invalidAnswers: envelope.invalidAnswers,
          lastPollAt: now.toISOString(),
        }),
      });
      if (!kept) return { status: await currentStatus(row.id) };
      return { status: 'open', challenge: view(row.id, expiresAt, step.challenge) };
    },
  };
}

import { z } from 'zod';
import { challengeView } from './challenges';

export const connectorStatus = z.enum(['ok', 'needs_attention', 'error', 'disabled']);
export type ConnectorStatus = z.infer<typeof connectorStatus>;

const isoTimestamp = z.iso.datetime();

/** The caller's own connector: full health information. */
export const ownConnectorInfo = z.object({
  id: z.string(),
  type: z.string(),
  status: connectorStatus,
  isOwner: z.literal(true),
  experimental: z.boolean(),
  lastSuccessAt: isoTimestamp.nullable(),
  /** Stable machine code (never a raw bank message). */
  lastErrorCode: z.string().nullable(),
  consentExpiresAt: isoTimestamp.nullable(),
});

/** Someone else's connector behind an account visible to the household: status only. */
export const sharedConnectorInfo = z.object({
  id: z.string(),
  type: z.string(),
  status: connectorStatus,
  isOwner: z.literal(false),
  lastSuccessAt: isoTimestamp.nullable(),
});

export const connectorInfo = z.discriminatedUnion('isOwner', [
  ownConnectorInfo,
  sharedConnectorInfo,
]);
export type ConnectorInfo = z.infer<typeof connectorInfo>;

export const connectorListResponse = z.object({ connectors: z.array(connectorInfo) });
export type ConnectorListResponse = z.infer<typeof connectorListResponse>;

export const connectorIdParams = z.object({ id: z.uuid() });

export const syncStartedResponse = z.object({ runId: z.string() });
export type SyncStartedResponse = z.infer<typeof syncStartedResponse>;

/**
 * Visibility defaults for the accounts a connector discovers. `owner_only` without `countsTowardBudgets`
 * means the accounts do not count toward budgets (same rule as `PATCH /accounts/:id`).
 */
export const accountDefaults = z.object({
  visibility: z.enum(['household', 'owner_only']).optional(),
  countsTowardBudgets: z.boolean().optional(),
});
export type AccountDefaults = z.infer<typeof accountDefaults>;

/** `POST /connectors`: `config` is validated per connector type on the server. */
export const createConnectorRequest = z.object({
  type: z.string().min(1).max(64),
  config: z.record(z.string(), z.json()),
  accountDefaults: accountDefaults.optional(),
});
export type CreateConnectorRequest = z.infer<typeof createConnectorRequest>;

export const connectStartedResponse = z.object({
  connectorId: z.uuid(),
  challenge: challengeView.optional(),
});
export type ConnectStartedResponse = z.infer<typeof connectStartedResponse>;

export const reconnectResponse = z.object({ challenge: challengeView.optional() });
export type ReconnectResponse = z.infer<typeof reconnectResponse>;

/** `GET /connectors/types`: connector types the server has enabled (e.g. `fints`, `fake`). */
export const connectorTypesResponse = z.object({ types: z.array(z.string()) });
export type ConnectorTypesResponse = z.infer<typeof connectorTypesResponse>;

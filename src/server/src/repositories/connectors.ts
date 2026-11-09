import { decryptString, encryptField, type DataKey } from '../crypto/index.js';
import type { ConnectorState } from '../connectors/types.js';

const aad = (column: string, rowId: string) => ({ table: 'connectors', column, rowId });

/** Connector state is opaque JSON, stored encrypted in `connectors.state_enc` (AAD binds it to the row). */
export function encryptConnectorState(
  dk: DataKey,
  connectorId: string,
  state: ConnectorState,
): Buffer {
  return encryptField(dk, JSON.stringify(state), aad('state', connectorId));
}

/** A connector that never authenticated has no state; that reads as the empty object. */
export function decryptConnectorState(
  dk: DataKey,
  connectorId: string,
  enc: Buffer | null,
): ConnectorState {
  if (enc === null) return {};
  return JSON.parse(decryptString(dk, enc, aad('state', connectorId))) as ConnectorState;
}

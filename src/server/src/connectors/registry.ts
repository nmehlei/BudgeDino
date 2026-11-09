import type { Connector } from './types.js';

export class UnknownConnectorError extends Error {
  constructor(readonly connectorType: string) {
    super(`Unknown connector type: ${connectorType}`);
    this.name = 'UnknownConnectorError';
  }
}

export interface ConnectorRegistry {
  get(type: string): Connector;
  types(): string[];
}

export function createConnectorRegistry(connectors: Connector[]): ConnectorRegistry {
  const byType = new Map<string, Connector>();
  for (const c of connectors) {
    if (byType.has(c.type)) throw new Error(`Duplicate connector type: ${c.type}`);
    byType.set(c.type, c);
  }
  return {
    get(type) {
      const c = byType.get(type);
      if (!c) throw new UnknownConnectorError(type);
      return c;
    },
    types: () => [...byType.keys()],
  };
}

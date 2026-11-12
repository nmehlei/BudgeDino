import { useQuery } from '@tanstack/react-query';

import { isApiClientError } from '../api/errors';
import { useApi } from '../api/useApi';

export const connectorsKey = ['connectors'] as const;
export const connectorTypesKey = ['connector-types'] as const;

export function useConnectors() {
  const api = useApi();
  return useQuery({
    queryKey: connectorsKey,
    queryFn: async () => (await api.listConnectors()).connectors,
  });
}

/** Enabled connector types of the server; used to show "Demo bank" only when `fake` is enabled. */
export function useConnectorTypes() {
  const api = useApi();
  return useQuery({
    queryKey: connectorTypesKey,
    queryFn: async () => (await api.listConnectorTypes()).types,
  });
}

/** User-facing text for a failed connection action. Never includes request or response data. */
export function describeActionError(error: unknown, fallback: string): string {
  if (isApiClientError(error)) {
    switch (error.error.kind) {
      case 'network':
        return 'No connection. Try again when you are online.';
      case 'rate_limited':
        return `Too many requests, try again in ${error.error.retryAfterSec} s.`;
      case 'unauthorized':
        return 'Your session expired.';
      case 'validation':
        return 'The bank details were rejected. Check them and try again.';
      case 'server':
        if (error.error.status === 404) return 'This connection no longer exists.';
        break;
      default:
        break;
    }
  }
  return fallback;
}

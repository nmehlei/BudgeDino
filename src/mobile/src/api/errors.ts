export interface ValidationIssue {
  path: string;
  message: string;
}

/**
 * Every failure the API client can produce. Never carries request or response data.
 *
 * - `validation`: HTTP 400 and 422 (`issues` is empty when the server sent none).
 * - `server`: 5xx and any other unexpected status (403, 404, 409, ...), keyed by `status`.
 */
export type ApiError =
  | { kind: 'network' }
  | { kind: 'unauthorized' }
  | { kind: 'rate_limited'; retryAfterSec: number }
  | { kind: 'validation'; issues: ValidationIssue[] }
  | { kind: 'server'; status: number }
  | { kind: 'schema_mismatch' };

/** Thrown by the client; `error` is the typed, switchable part. The message never holds payloads. */
export class ApiClientError extends Error {
  readonly error: ApiError;

  constructor(error: ApiError) {
    super(`API request failed: ${error.kind}`);
    this.name = 'ApiClientError';
    this.error = error;
  }
}

export function isApiClientError(value: unknown): value is ApiClientError {
  return value instanceof ApiClientError;
}

/** True for a failed request that never reached the server (offline, unreachable). */
export function isNetworkError(error: unknown): boolean {
  return isApiClientError(error) && error.error.kind === 'network';
}

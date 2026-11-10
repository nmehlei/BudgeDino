import { isApiClientError } from '../api/errors';

export const SESSION_EXPIRED_MESSAGE = 'Session expired, please sign in again';

const UNREACHABLE = 'Cannot reach the server. Check the address and your connection.';

function minutes(retryAfterSec: number): string {
  const n = Math.max(1, Math.ceil(retryAfterSec / 60));
  return `${String(n)} ${n === 1 ? 'minute' : 'minutes'}`;
}

function common(error: unknown): string | null {
  if (!isApiClientError(error)) return null;
  const e = error.error;
  if (e.kind === 'rate_limited') {
    return `Too many attempts, try again in ${minutes(e.retryAfterSec)}`;
  }
  if (e.kind === 'network') return UNREACHABLE;
  return null;
}

/** Deliberately never says which factor failed. */
export function loginErrorMessage(error: unknown): string {
  return common(error) ?? 'Login failed';
}

export function registerErrorMessage(error: unknown): string {
  return (
    common(error) ??
    'Registration failed. Check the invite token and your details (password: at least 12 characters).'
  );
}

export function confirmErrorMessage(error: unknown): string {
  return common(error) ?? 'That code was not accepted. Check the code and try again.';
}

export function healthErrorMessage(error: unknown): string {
  if (isApiClientError(error) && error.error.kind === 'network') return UNREACHABLE;
  return 'This does not look like a BudgeDino server.';
}

import { createApiClient } from '../api/client';

/**
 * Client for the unauthenticated endpoints (health, register, login). It sends no token and a 401
 * (wrong credentials) is just an error here: it must never wipe or "expire" a session.
 */
export function createAuthApi(baseUrl: string) {
  return createApiClient({ baseUrl, getToken: () => null, onUnauthorized: () => undefined });
}

export type AuthApi = ReturnType<typeof createAuthApi>;

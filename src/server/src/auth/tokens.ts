import { createHash, randomBytes } from 'node:crypto';

/** 32 random bytes, base64url (43 chars). Used for session and invite tokens. */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Only this SHA-256 hex digest is ever stored; the token itself is shown once. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

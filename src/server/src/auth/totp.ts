import { generateSecret, generateSync, generateURI, verifySync } from 'otplib';

const PERIOD = 30;
const DIGITS = 6;
const ISSUER = 'BudgeDino';

export function generateTotpSecret(): string {
  return generateSecret();
}

export function totpProvisioningUri(secret: string, accountLabel: string): string {
  return generateURI({
    issuer: ISSUER,
    label: accountLabel,
    secret,
    algorithm: 'sha1',
    digits: DIGITS,
    period: PERIOD,
  });
}

export type TotpResult = { valid: true; step: number } | { valid: false };

/**
 * Verifies a 6-digit code with a window of +-1 step (30 s). On success returns the time step the code
 * belongs to; callers must persist it and reject any later code whose step is not strictly greater
 * (replay guard).
 */
export function verifyTotp(secret: string, code: string, atMs: number): TotpResult {
  if (!/^\d{6}$/.test(code)) return { valid: false };
  const epoch = Math.floor(atMs / 1000);
  const result = verifySync({
    secret,
    token: code,
    strategy: 'totp',
    digits: DIGITS,
    period: PERIOD,
    epoch,
    epochTolerance: PERIOD,
  });
  if (!result.valid) return { valid: false };
  return { valid: true, step: Math.floor(epoch / PERIOD) + result.delta };
}

/** Current code for a secret; used by tests and tooling, never by request handling. */
export function generateTotpCode(secret: string, atMs: number): string {
  return generateSync({
    secret,
    strategy: 'totp',
    digits: DIGITS,
    period: PERIOD,
    epoch: Math.floor(atMs / 1000),
  });
}

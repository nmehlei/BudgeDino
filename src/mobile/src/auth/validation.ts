import { PASSWORD_MIN_LENGTH } from '@budgedino/shared';

import { normalizeServerUrl } from '../session/session-store';

export const TOTP_LENGTH = 6;

export type ServerUrlResult = { ok: true; url: string } | { ok: false; message: string };

const URL_PATTERN = /^(https?):\/\/[^\s/?#@]+(\/[^\s?#]*)?$/i;

/** Normalises a server URL and enforces https (http only where cleartext is allowed). */
export function validateServerUrl(raw: string, allowHttp: boolean): ServerUrlResult {
  const trimmed = raw.trim();
  const match = URL_PATTERN.exec(trimmed);
  if (!match) {
    return { ok: false, message: 'Enter a full address such as https://budget.example.com' };
  }
  if (match[1]?.toLowerCase() === 'http' && !allowHttp) {
    return { ok: false, message: 'The server address must start with https://' };
  }
  return { ok: true, url: normalizeServerUrl(trimmed) };
}

/** Keeps digits only, at most six: the TOTP field never holds anything else. */
export function sanitizeTotp(input: string): string {
  return input.replace(/\D/g, '').slice(0, TOTP_LENGTH);
}

export function isCompleteTotp(code: string): boolean {
  return /^\d{6}$/.test(code);
}

/** The base32 secret inside an otpauth:// provisioning URI, for manual entry. */
export function parseTotpSecret(uri: string): string | null {
  const match = /[?&]secret=([^&#]+)/i.exec(uri);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export interface PasswordHint {
  level: 'short' | 'ok' | 'strong';
  text: string;
}

/** Hint only; the server enforces the real rule (minimum length). */
export function passwordHint(password: string): PasswordHint {
  if (password.length < PASSWORD_MIN_LENGTH) {
    const missing = PASSWORD_MIN_LENGTH - password.length;
    return {
      level: 'short',
      text: `At least ${String(PASSWORD_MIN_LENGTH)} characters (${String(missing)} more)`,
    };
  }
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (password.length >= 16 || classes >= 3) return { level: 'strong', text: 'Strong password' };
  return { level: 'ok', text: 'Fine. A longer phrase or mixed characters is stronger' };
}

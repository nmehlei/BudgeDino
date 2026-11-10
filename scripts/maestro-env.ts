/**
 * Extracts BUDGEDINO_DEV_TOTP_SECRET from the text of an env file. Only that key is read: the file is
 * shell syntax (`PORT=${PORT:-8080}`), so other values are not interpreted. Quotes are stripped and
 * a value that still contains `${` is ignored.
 */
export function parseTotpSecret(text: string): string | undefined {
  for (const line of text.split('\n')) {
    const m = /^\s*BUDGEDINO_DEV_TOTP_SECRET=(.*)$/.exec(line);
    if (!m) continue;
    const value = (m[1] ?? '').trim().replace(/^(["'])(.*)\1$/, '$2');
    if (value && !value.includes('${')) return value;
  }
  return undefined;
}

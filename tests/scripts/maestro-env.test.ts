import { describe, expect, it } from 'vitest';

import { parseTotpSecret } from '../../scripts/maestro-env';

describe('parseTotpSecret', () => {
  it('reads only the TOTP secret and ignores shell-style lines like PORT=${PORT:-8080}', () => {
    const text =
      'PORT=${PORT:-8080}\n# BUDGEDINO_DEV_TOTP_SECRET=COMMENTED\nBUDGEDINO_DEV_TOTP_SECRET=ABC234\n';
    expect(parseTotpSecret(text)).toBe('ABC234');
  });

  it('strips quotes and ignores unexpanded shell syntax', () => {
    expect(parseTotpSecret('BUDGEDINO_DEV_TOTP_SECRET="ABC234"')).toBe('ABC234');
    expect(parseTotpSecret('BUDGEDINO_DEV_TOTP_SECRET=${X:-ABC}')).toBeUndefined();
    expect(parseTotpSecret('FOO=bar')).toBeUndefined();
  });
});

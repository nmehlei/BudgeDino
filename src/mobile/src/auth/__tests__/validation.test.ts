import {
  isCompleteTotp,
  parseTotpSecret,
  passwordHint,
  sanitizeTotp,
  validateServerUrl,
} from '../validation';
import { loginErrorMessage, registerErrorMessage } from '../messages';
import { ApiClientError } from '../../api/errors';

describe('validateServerUrl', () => {
  it('normalises trailing slashes and whitespace', () => {
    expect(validateServerUrl('  https://budget.example.com// ', false)).toEqual({
      ok: true,
      url: 'https://budget.example.com',
    });
  });

  it('rejects http in production and allows it where cleartext is allowed', () => {
    expect(validateServerUrl('http://192.168.1.5:3000', false).ok).toBe(false);
    expect(validateServerUrl('http://192.168.1.5:3000/', true)).toEqual({
      ok: true,
      url: 'http://192.168.1.5:3000',
    });
  });

  it.each([
    '',
    'budget.example.com',
    'ftp://x.test',
    'https://',
    'https://u:p@x.test',
    'https://a b.test',
  ])('rejects %j', (raw) => {
    expect(validateServerUrl(raw, true).ok).toBe(false);
  });
});

describe('normalizeServerUrl via validateServerUrl', () => {
  it('lowercases scheme and host but keeps the path case', () => {
    expect(validateServerUrl('HTTPS://Budget.Example.COM/Sub', false)).toEqual({
      ok: true,
      url: 'https://budget.example.com/Sub',
    });
  });

  it('keeps a path suffix and strips a pasted /api/v1', () => {
    expect(validateServerUrl('https://h.test/sub', false)).toEqual({
      ok: true,
      url: 'https://h.test/sub',
    });
    for (const raw of [
      'https://h.test/api/v1',
      'https://h.test/api/v1/',
      'https://h.test/sub/api/v1',
    ]) {
      const res = validateServerUrl(raw, false);
      expect(res.ok && res.url).toBe(
        raw.includes('/sub') ? 'https://h.test/sub' : 'https://h.test',
      );
    }
  });

  it('rejects HTTP:// in production', () => {
    expect(validateServerUrl('HTTP://h.test', false).ok).toBe(false);
    expect(validateServerUrl('HTTP://H.test', true)).toEqual({ ok: true, url: 'http://h.test' });
  });
});

describe('TOTP helpers', () => {
  it('keeps only up to six digits', () => {
    expect(sanitizeTotp('12a3-4 5678')).toBe('123456');
    expect(sanitizeTotp('abc')).toBe('');
    expect(isCompleteTotp('123456')).toBe(true);
    expect(isCompleteTotp('12345')).toBe(false);
  });

  it('parses the secret out of the provisioning URI', () => {
    expect(
      parseTotpSecret(
        'otpauth://totp/BudgeDino:a%40b.test?secret=JBSWY3DPEHPK3PXP&issuer=BudgeDino',
      ),
    ).toBe('JBSWY3DPEHPK3PXP');
    expect(parseTotpSecret('otpauth://totp/x?issuer=y')).toBeNull();
  });
});

describe('passwordHint', () => {
  it('flags short passwords and rates longer ones', () => {
    expect(passwordHint('short').level).toBe('short');
    expect(passwordHint('aaaaaaaaaaaa').level).toBe('ok');
    expect(passwordHint('correct horse battery').level).toBe('strong');
  });
});

describe('messages', () => {
  it('is generic for every login failure and specific only for rate limits', () => {
    expect(loginErrorMessage(new ApiClientError({ kind: 'unauthorized' }))).toBe('Login failed');
    expect(loginErrorMessage(new ApiClientError({ kind: 'validation', issues: [] }))).toBe(
      'Login failed',
    );
    expect(
      loginErrorMessage(new ApiClientError({ kind: 'rate_limited', retryAfterSec: 600 })),
    ).toBe('Too many attempts, try again in 10 minutes');
    expect(loginErrorMessage(new ApiClientError({ kind: 'rate_limited', retryAfterSec: 5 }))).toBe(
      'Too many attempts, try again in 1 minute',
    );
    expect(registerErrorMessage(new ApiClientError({ kind: 'server', status: 404 }))).toContain(
      'Registration failed',
    );
  });
});

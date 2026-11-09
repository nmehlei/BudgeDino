import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '@budgedino/server/config';

const KEY = randomBytes(32).toString('base64');
const base = {
  DATABASE_URL: 'postgres://user:hunter2-secret@db:5432/budgedino',
  BUDGEDINO_MASTER_KEY: KEY,
};

function problems(env: Record<string, string | undefined>): string {
  try {
    loadConfig(env);
  } catch (e) {
    if (e instanceof ConfigError) return e.message;
    throw e;
  }
  throw new Error('expected a ConfigError');
}

describe('loadConfig', () => {
  it('applies the documented defaults', () => {
    const c = loadConfig(base);
    expect(c).toMatchObject({
      port: 8080,
      host: '0.0.0.0',
      trustProxy: undefined,
      maxConcurrentSyncs: 2,
      connectors: [],
    });
    expect(c.master.id).toMatch(/^[0-9a-f]{8}$/);
  });

  it('reads overrides', () => {
    const c = loadConfig({
      ...base,
      PORT: '9000',
      HOST: '127.0.0.1',
      BUDGEDINO_MAX_CONCURRENT_SYNCS: '5',
      BUDGEDINO_CONNECTORS: ' fake , fake ',
      NODE_ENV: 'development',
    });
    expect(c).toMatchObject({
      port: 9000,
      host: '127.0.0.1',
      maxConcurrentSyncs: 5,
      connectors: ['fake'],
    });
  });

  it.each([
    ['1', 1],
    ['2', 2],
    ['10.0.0.0/8,192.168.1.5', '10.0.0.0/8,192.168.1.5'],
    ['fd00::/8', 'fd00::/8'],
  ])('accepts BUDGEDINO_TRUST_PROXY=%s', (value, expected) => {
    expect(loadConfig({ ...base, BUDGEDINO_TRUST_PROXY: value }).trustProxy).toBe(expected);
  });

  it.each(['', '0', 'false'])('treats BUDGEDINO_TRUST_PROXY=%j as off', (value) => {
    expect(loadConfig({ ...base, BUDGEDINO_TRUST_PROXY: value }).trustProxy).toBeUndefined();
  });

  it.each(['true', 'yes', '10.0.0.0/33', '300.1.1.1', '10.0.0.0/8,', '99'])(
    'rejects BUDGEDINO_TRUST_PROXY=%s',
    (value) => {
      expect(problems({ ...base, BUDGEDINO_TRUST_PROXY: value })).toContain(
        'BUDGEDINO_TRUST_PROXY',
      );
    },
  );

  it('only allows the fake connector outside production or with BUDGEDINO_ALLOW_FAKE=1', () => {
    const env = { ...base, BUDGEDINO_CONNECTORS: 'fake' };
    expect(problems({ ...env, NODE_ENV: 'production' })).toContain('"fake" is only allowed');
    expect(
      loadConfig({ ...env, NODE_ENV: 'production', BUDGEDINO_ALLOW_FAKE: '1' }).connectors,
    ).toEqual(['fake']);
    expect(loadConfig({ ...env, NODE_ENV: 'test' }).connectors).toEqual(['fake']);
    expect(loadConfig({ ...env }).connectors).toEqual(['fake']);
    expect(loadConfig({ ...base, NODE_ENV: 'production' }).connectors).toEqual([]);
  });

  it('rejects unknown connectors', () => {
    expect(problems({ ...base, BUDGEDINO_CONNECTORS: 'dkb' })).toContain('unknown connector');
  });

  it('lists every problem and never echoes a value', () => {
    const msg = problems({
      DATABASE_URL: 'mysql://user:hunter2-secret@db/x',
      BUDGEDINO_MASTER_KEY: 'not-a-valid-key-SECRETVALUE',
      PORT: 'SECRETPORT',
      BUDGEDINO_MAX_CONCURRENT_SYNCS: '0',
      BUDGEDINO_TRUST_PROXY: 'SECRETPROXY',
    });
    for (const name of [
      'DATABASE_URL',
      'BUDGEDINO_MASTER_KEY',
      'PORT',
      'BUDGEDINO_MAX_CONCURRENT_SYNCS',
      'BUDGEDINO_TRUST_PROXY',
    ]) {
      expect(msg).toContain(name);
    }
    expect(msg).not.toMatch(/hunter2|SECRET/);
  });

  describe('fints', () => {
    it('requires a product id when fints is enabled, naming the variable only', () => {
      const msg = problems({ ...base, BUDGEDINO_CONNECTORS: 'fints' });
      expect(msg).toContain('BUDGEDINO_FINTS_PRODUCT_ID');
      expect(msg).not.toContain('hunter2');
    });
    it('exposes fints settings with a default product version', () => {
      const c = loadConfig({
        ...base,
        BUDGEDINO_CONNECTORS: 'fints',
        BUDGEDINO_FINTS_PRODUCT_ID: 'PID',
      });
      expect(c.connectors).toEqual(['fints']);
      expect(c.fints).toEqual({ productId: 'PID', productVersion: '1.0' });
    });
    it('leaves fints unset when not enabled', () => {
      expect(loadConfig({ ...base, BUDGEDINO_FINTS_PRODUCT_ID: 'PID' }).fints).toBeUndefined();
    });
  });

  it('requires DATABASE_URL and a master key', () => {
    const msg = problems({});
    expect(msg).toContain('DATABASE_URL: is required');
    expect(msg).toContain('Neither BUDGEDINO_MASTER_KEY nor BUDGEDINO_MASTER_KEY_FILE');
  });
});

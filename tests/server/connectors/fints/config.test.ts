import { describe, expect, it } from 'vitest';
import { FINTS_BANKS } from '@budgedino/server/connectors/fints/banks';
import { fintsConfigSchema } from '@budgedino/server/connectors/fints/config';

const ok = { bank: 'dkb', userId: 'u', pin: 'p' };

describe('fintsConfigSchema', () => {
  it('accepts a minimal and a full config', () => {
    expect(fintsConfigSchema.safeParse(ok).success).toBe(true);
    expect(
      fintsConfigSchema.safeParse({ ...ok, bank: 'comdirect', tanMethodId: 920 }).success,
    ).toBe(true);
  });
  it('rejects extra keys, unknown banks, empty and oversized values', () => {
    expect(fintsConfigSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(fintsConfigSchema.safeParse({ ...ok, bank: 'ing' }).success).toBe(false);
    expect(fintsConfigSchema.safeParse({ ...ok, userId: '' }).success).toBe(false);
    expect(fintsConfigSchema.safeParse({ ...ok, pin: 'x'.repeat(65) }).success).toBe(false);
    expect(fintsConfigSchema.safeParse({ ...ok, tanMethodId: 1.5 }).success).toBe(false);
  });
});

describe('FINTS_BANKS', () => {
  it('lists DKB and Comdirect', () => {
    expect(FINTS_BANKS.dkb).toMatchObject({ blz: '12030000', url: 'https://fints.dkb.de/fints' });
    expect(FINTS_BANKS.comdirect).toMatchObject({
      blz: '20041111',
      url: 'https://fints.comdirect.de/fints',
    });
  });
});

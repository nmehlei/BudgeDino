import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  MasterKeyError,
  blindIndex,
  decryptField,
  decryptString,
  encryptField,
  generateDataKey,
  loadMasterKey,
  unwrapDataKey,
  wrapDataKey,
  type FieldAad,
} from '@budgedino/server/crypto';

const aad: FieldAad = { table: 'transactions', column: 'amount', rowId: 'row-1' };
const masterEnv = (bytes = randomBytes(32)) => ({
  BUDGEDINO_MASTER_KEY: bytes.toString('base64'),
});

describe('field encryption', () => {
  it('round-trips strings and buffers', () => {
    const dk = generateDataKey();
    const blob = encryptField(dk, 'DE89 3704 0044 0532 0130 00', aad);
    expect(decryptString(dk, blob, aad)).toBe('DE89 3704 0044 0532 0130 00');
    const bin = randomBytes(40);
    expect(decryptField(dk, encryptField(dk, bin, aad), aad).equals(bin)).toBe(true);
  });

  it('uses blob layout version|iv|tag|ciphertext', () => {
    const blob = encryptField(generateDataKey(), 'abc', aad);
    expect(blob[0]).toBe(0x01);
    expect(blob.length).toBe(1 + 12 + 16 + 3);
  });

  it('produces different blobs for the same plaintext', () => {
    const dk = generateDataKey();
    expect(encryptField(dk, 'x', aad).equals(encryptField(dk, 'x', aad))).toBe(false);
  });

  it('rejects tampered version-adjacent bytes: iv, tag and ciphertext', () => {
    const dk = generateDataKey();
    for (const index of [1, 13, 29]) {
      const blob = encryptField(dk, 'secret', aad);
      blob[index] = (blob[index] ?? 0) ^ 0xff;
      expect(() => decryptField(dk, blob, aad)).toThrow(/authentication/);
    }
  });

  it('rejects AAD of another row, column or table', () => {
    const dk = generateDataKey();
    const blob = encryptField(dk, 'secret', aad);
    expect(() => decryptField(dk, blob, { ...aad, rowId: 'row-2' })).toThrow(/authentication/);
    expect(() => decryptField(dk, blob, { ...aad, column: 'payee' })).toThrow(/authentication/);
    expect(() => decryptField(dk, blob, { ...aad, table: 'accounts' })).toThrow(/authentication/);
  });

  it('does not allow separator ambiguity in AAD', () => {
    const dk = generateDataKey();
    const blob = encryptField(dk, 's', { table: 'a|b', column: 'c', rowId: 'd' });
    expect(() => decryptField(dk, blob, { table: 'a', column: 'b|c', rowId: 'd' })).toThrow(
      /authentication/,
    );
  });

  it('rejects the wrong data key', () => {
    const blob = encryptField(generateDataKey(), 'secret', aad);
    expect(() => decryptField(generateDataKey(), blob, aad)).toThrow(/authentication/);
  });

  it('rejects unknown versions and short blobs with a clear error', () => {
    const dk = generateDataKey();
    const blob = encryptField(dk, 'secret', aad);
    blob[0] = 0x02;
    expect(() => decryptField(dk, blob, aad)).toThrow(/unsupported.*version/i);
    expect(() => decryptField(dk, Buffer.alloc(0), aad)).toThrow(/too short/i);
    expect(() => decryptField(dk, Buffer.from([1, ...new Array<number>(27).fill(0)]), aad)).toThrow(
      /too short/i,
    );
  });

  it('accepts an empty plaintext', () => {
    const dk = generateDataKey();
    expect(decryptString(dk, encryptField(dk, '', aad), aad)).toBe('');
  });
});

describe('data key wrapping', () => {
  it('round-trips a wrapped data key', () => {
    const master = loadMasterKey(masterEnv());
    const dk = generateDataKey();
    const blob = encryptField(dk, 'secret', aad);
    const unwrapped = unwrapDataKey(master, wrapDataKey(master, dk, 'h1'), 'h1');
    expect(decryptString(unwrapped, blob, aad)).toBe('secret');
  });

  it('fails to unwrap with a different master key', () => {
    const wrapped = wrapDataKey(loadMasterKey(masterEnv()), generateDataKey(), 'h1');
    expect(() => unwrapDataKey(loadMasterKey(masterEnv()), wrapped, 'h1')).toThrow(
      /authentication/,
    );
  });

  it('rejects tampered, short and unknown-version wrapped keys', () => {
    const master = loadMasterKey(masterEnv());
    const wrapped = wrapDataKey(master, generateDataKey(), 'h1');
    const tampered = Buffer.from(wrapped);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
    expect(() => unwrapDataKey(master, tampered, 'h1')).toThrow(/authentication/);
    expect(() => unwrapDataKey(master, wrapped.subarray(0, 10), 'h1')).toThrow(/too short/i);
    const v = Buffer.from(wrapped);
    v[0] = 9;
    expect(() => unwrapDataKey(master, v, 'h1')).toThrow(/unsupported.*version/i);
  });
});

describe('data key wrapping binding', () => {
  it('rejects unwrapping for a different household', () => {
    const master = loadMasterKey(masterEnv());
    const wrapped = wrapDataKey(master, generateDataKey(), 'household-A');
    expect(() => unwrapDataKey(master, wrapped, 'household-B')).toThrow(/authentication/);
  });
});

describe('blindIndex', () => {
  it('is deterministic per key and purpose, hex SHA-256 sized', () => {
    const dk = generateDataKey();
    const a = blindIndex(dk, 'tx-dedup', 'value');
    expect(blindIndex(dk, 'tx-dedup', 'value')).toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs across keys, purposes and values', () => {
    const dk = generateDataKey();
    const a = blindIndex(dk, 'p1', 'v');
    expect(blindIndex(generateDataKey(), 'p1', 'v')).not.toBe(a);
    expect(blindIndex(dk, 'p2', 'v')).not.toBe(a);
    expect(blindIndex(dk, 'p1', 'w')).not.toBe(a);
  });
});

describe('loadMasterKey', () => {
  it('loads a valid base64 key and derives an 8-hex id', () => {
    expect(loadMasterKey(masterEnv()).id).toMatch(/^[0-9a-f]{8}$/);
  });

  it('gives equal ids for equal keys', () => {
    const bytes = randomBytes(32);
    expect(loadMasterKey(masterEnv(bytes)).id).toBe(loadMasterKey(masterEnv(bytes)).id);
  });

  it('rejects a 31-byte key without leaking the value', () => {
    const value = randomBytes(31).toString('base64');
    let message = '';
    try {
      loadMasterKey({ BUDGEDINO_MASTER_KEY: value });
    } catch (e) {
      expect(e).toBeInstanceOf(MasterKeyError);
      message = (e as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain(value);
  });

  it('rejects non-canonical base64 (whitespace inside, wrong padding, url-safe alphabet)', () => {
    const good = randomBytes(32).toString('base64');
    expect(() =>
      loadMasterKey({ BUDGEDINO_MASTER_KEY: `${good.slice(0, 10)}\n${good.slice(10)}` }),
    ).toThrow(MasterKeyError);
    expect(() => loadMasterKey({ BUDGEDINO_MASTER_KEY: good.slice(0, -1) })).toThrow(
      MasterKeyError,
    );
    expect(loadMasterKey({ BUDGEDINO_MASTER_KEY: `  ${good}\n` }).id).toMatch(/^[0-9a-f]{8}$/);
  });

  it('rejects missing, malformed, and ambiguous configuration', () => {
    expect(() => loadMasterKey({})).toThrow(MasterKeyError);
    expect(() => loadMasterKey({ BUDGEDINO_MASTER_KEY: '!!not base64!!' })).toThrow(MasterKeyError);
    expect(() =>
      loadMasterKey({ ...masterEnv(), BUDGEDINO_MASTER_KEY_FILE: '/nonexistent' }),
    ).toThrow(MasterKeyError);
    expect(() => loadMasterKey({ BUDGEDINO_MASTER_KEY_FILE: '/nonexistent/x' })).toThrow(
      MasterKeyError,
    );
  });
});

describe('opaque keys', () => {
  it('never reveals key bytes via JSON, inspect or string conversion', () => {
    const bytes = randomBytes(32);
    const master = loadMasterKey(masterEnv(bytes));
    const dk = generateDataKey();
    const unwrapped = unwrapDataKey(master, wrapDataKey(master, dk, 'h1'), 'h1');
    const dump = [master, dk, unwrapped]
      .flatMap((k) => [JSON.stringify(k), inspect(k, { depth: 5, showHidden: true }), String(k)])
      .join('\n');
    expect(dump).not.toContain(bytes.toString('hex'));
    expect(dump).not.toContain(bytes.toString('base64'));
    expect(Object.keys(dk)).toEqual([]);
    expect(Object.getOwnPropertyNames(dk)).toEqual([]);
    expect(Object.getOwnPropertyNames(master)).toEqual(['id']);
  });
});

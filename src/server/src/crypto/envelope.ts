import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { masterKeyBytes, type MasterKey } from './master-key.js';

const VERSION = 0x01;
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = 1 + IV_LEN + TAG_LEN;
const ALGO = 'aes-256-gcm';

/** Opaque data key; raw bytes are held in a module-private WeakMap. */
export interface DataKey {
  readonly __brand: 'DataKey';
}

const dataKeyBytes = new WeakMap<object, Buffer>();

class DataKeyImpl {
  declare readonly __brand: 'DataKey';
  constructor(bytes: Buffer) {
    dataKeyBytes.set(this, bytes);
  }
}

function newDataKey(bytes: Buffer): DataKey {
  return new DataKeyImpl(bytes) as unknown as DataKey;
}

function raw(dk: DataKey): Buffer {
  const bytes = dataKeyBytes.get(dk);
  if (!bytes) throw new Error('Invalid DataKey');
  return bytes;
}

export interface FieldAad {
  table: string;
  column: string;
  rowId: string;
}

function subkey(dk: DataKey, label: string): Buffer {
  return Buffer.from(hkdfSync('sha256', raw(dk), Buffer.alloc(0), label, 32));
}

const esc = (s: string) => s.replaceAll('\\', '\\\\').replaceAll('|', '\\|');

/** AAD = version byte || UTF-8 of the (escaped, `|`-joined) components, so the version is authenticated. */
function aadOf(...components: string[]): Buffer {
  return Buffer.concat([
    Buffer.from([VERSION]),
    Buffer.from(components.map(esc).join('|'), 'utf8'),
  ]);
}

function encodeAad(aad: FieldAad): Buffer {
  return aadOf(aad.table, aad.column, aad.rowId);
}

function seal(key: Buffer, plaintext: Buffer, aad: Buffer): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv, { authTagLength: TAG_LEN });
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ct]);
}

function open(key: Buffer, blob: Buffer, aad: Buffer, what: string): Buffer {
  if (blob.length < HEADER_LEN) throw new Error(`Encrypted ${what} is too short`);
  if (blob[0] !== VERSION) throw new Error(`Unsupported ${what} format version`);
  const iv = blob.subarray(1, 1 + IV_LEN);
  const tag = blob.subarray(1 + IV_LEN, HEADER_LEN);
  const decipher = createDecipheriv(ALGO, key, iv, { authTagLength: TAG_LEN });
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(blob.subarray(HEADER_LEN)), decipher.final()]);
  } catch {
    throw new Error(`Decryption of ${what} failed: authentication error`);
  }
}

export function generateDataKey(): DataKey {
  return newDataKey(randomBytes(32));
}

/** Wraps with AES-256-GCM under the master key directly; AAD = version || master key id || householdId. */
export function wrapDataKey(master: MasterKey, dk: DataKey, householdId: string): Buffer {
  return seal(masterKeyBytes(master), raw(dk), aadOf(master.id, householdId));
}

export function unwrapDataKey(master: MasterKey, wrapped: Buffer, householdId: string): DataKey {
  const bytes = open(
    masterKeyBytes(master),
    wrapped,
    aadOf(master.id, householdId),
    'wrapped data key',
  );
  if (bytes.length !== 32) throw new Error('Unwrapped data key has an invalid length');
  return newDataKey(bytes);
}

export function encryptField(dk: DataKey, plaintext: string | Buffer, aad: FieldAad): Buffer {
  const data = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
  return seal(subkey(dk, 'enc'), data, encodeAad(aad));
}

export function decryptField(dk: DataKey, blob: Buffer, aad: FieldAad): Buffer {
  return open(subkey(dk, 'enc'), blob, encodeAad(aad), 'field');
}

export function decryptString(dk: DataKey, blob: Buffer, aad: FieldAad): string {
  return decryptField(dk, blob, aad).toString('utf8');
}

/** HMAC-SHA256 (hex) under a per-purpose HKDF subkey; for dedup keys and exact-match lookups. */
export function blindIndex(dk: DataKey, purpose: string, value: string): string {
  return createHmac('sha256', subkey(dk, `idx:${purpose}`))
    .update(value, 'utf8')
    .digest('hex');
}

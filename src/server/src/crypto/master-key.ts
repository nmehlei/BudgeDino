import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export class MasterKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MasterKeyError';
  }
}

/**
 * Opaque master key. Only `id` (first 8 hex chars of SHA-256 of the key) is visible; the key bytes
 * live in a module-private WeakMap so JSON, inspect and logging cannot reveal them.
 */
export interface MasterKey {
  readonly id: string;
}

const KEY_BYTES = 32;
const keyBytes = new WeakMap<object, Buffer>();

class MasterKeyImpl implements MasterKey {
  readonly id: string;
  constructor(bytes: Buffer) {
    this.id = createHash('sha256').update(bytes).digest('hex').slice(0, 8);
    keyBytes.set(this, bytes);
  }
}

/** Internal: raw master key bytes. Not re-exported from the package index. */
export function masterKeyBytes(master: MasterKey): Buffer {
  const bytes = keyBytes.get(master);
  if (!bytes) throw new MasterKeyError('Not a MasterKey created by loadMasterKey');
  return bytes;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function decode(raw: string): Buffer {
  const value = raw.trim();
  if (!BASE64.test(value)) throw new MasterKeyError('Master key is not valid base64');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== KEY_BYTES) {
    throw new MasterKeyError(`Master key must be exactly ${KEY_BYTES} bytes (base64-encoded)`);
  }
  return bytes;
}

/** Reads BUDGEDINO_MASTER_KEY or BUDGEDINO_MASTER_KEY_FILE (base64, 32 bytes). */
export function loadMasterKey(env: NodeJS.ProcessEnv): MasterKey {
  const inline = env['BUDGEDINO_MASTER_KEY'];
  const file = env['BUDGEDINO_MASTER_KEY_FILE'];
  if (inline && file) {
    throw new MasterKeyError(
      'Set only one of BUDGEDINO_MASTER_KEY and BUDGEDINO_MASTER_KEY_FILE, not both',
    );
  }
  if (inline) return new MasterKeyImpl(decode(inline));
  if (file) {
    let content: string;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      throw new MasterKeyError('Cannot read the file named by BUDGEDINO_MASTER_KEY_FILE');
    }
    return new MasterKeyImpl(decode(content));
  }
  throw new MasterKeyError('Neither BUDGEDINO_MASTER_KEY nor BUDGEDINO_MASTER_KEY_FILE is set');
}

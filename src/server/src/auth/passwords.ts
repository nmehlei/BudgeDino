import { randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

/** argon2id (the library default) with the OWASP minimum: 19 MiB memory, 2 iterations, 1 lane. */
const PARAMS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, PARAMS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Spends the same argon2 verification time as a real check, for logins whose email is unknown (or
 * whose member is disabled), so response time does not reveal which emails exist. Always false.
 */
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  await verifyPassword(await dummyHash, password);
  return false;
}

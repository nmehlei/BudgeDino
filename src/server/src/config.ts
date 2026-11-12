import { isIP } from 'node:net';
import { z } from 'zod';
import { loadMasterKey, MasterKeyError, type MasterKey } from './crypto/index.js';

/** Connector types a deployment can enable via `BUDGEDINO_CONNECTORS`. */
export const KNOWN_CONNECTORS = ['fake', 'fints'] as const;
export type ConnectorName = (typeof KNOWN_CONNECTORS)[number];

export interface Config {
  databaseUrl: string;
  master: MasterKey;
  port: number;
  host: string;
  /** Fastify `trustProxy`: hop count, or a list of trusted proxy addresses/CIDRs; `undefined` = off. */
  trustProxy: number | string | undefined;
  maxConcurrentSyncs: number;
  connectors: ConnectorName[];
  /** Present only when the `fints` connector is enabled (product id is then guaranteed). */
  fints?: { productId: string; productVersion: string };
}

/**
 * Thrown for invalid configuration. Messages name the variable and the rule only, never the value
 * (values can be credentials, e.g. inside `DATABASE_URL`).
 */
export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

function validTrustEntry(entry: string): boolean {
  const parts = entry.split('/');
  if (parts.length > 2) return false;
  const [addr = '', bits] = parts;
  const version = isIP(addr);
  if (version === 0) return false;
  if (bits === undefined) return true;
  if (!/^\d{1,3}$/.test(bits)) return false;
  return Number(bits) <= (version === 4 ? 32 : 128);
}

/** An optional integer variable: unset or empty means `fallback`. */
function intVar(fallback: number, min: number, max: number) {
  const message = `must be an integer between ${min} and ${max}`;
  return z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? String(fallback) : v.trim()))
    .pipe(z.string().regex(/^\d{1,6}$/, message))
    .transform(Number)
    .pipe(z.number().min(min, message).max(max, message));
}

const envSchema = z.object({
  DATABASE_URL: z
    .string({ error: 'is required' })
    .min(1, 'is required')
    .refine((v) => /^postgres(ql)?:\/\//.test(v), 'must be a postgres:// or postgresql:// URL'),
  PORT: intVar(8080, 1, 65535),
  HOST: z
    .string()
    .optional()
    .transform((v) => (v ? v : '0.0.0.0')),
  BUDGEDINO_MAX_CONCURRENT_SYNCS: intVar(2, 1, 20),
  BUDGEDINO_FINTS_PRODUCT_ID: z.string().optional(),
  BUDGEDINO_FINTS_PRODUCT_VERSION: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() !== '' ? v.trim() : '1.0')),
});

function parseTrustProxy(raw: string | undefined, problems: string[]): number | string | undefined {
  const v = raw?.trim();
  if (v === undefined || v === '' || v === '0' || v.toLowerCase() === 'false') return undefined;
  if (/^\d+$/.test(v)) {
    const hops = Number(v);
    if (hops > 10) problems.push('BUDGEDINO_TRUST_PROXY: hop count must be between 1 and 10');
    return hops;
  }
  const entries = v.split(',').map((e) => e.trim());
  if (entries.every((e) => e !== '' && validTrustEntry(e))) return entries.join(',');
  problems.push(
    'BUDGEDINO_TRUST_PROXY: must be a hop count (integer) or a comma-separated list of IPs/CIDRs ' +
      '("true" is not accepted: it would trust any client-supplied X-Forwarded-For)',
  );
  return undefined;
}

function parseConnectors(
  raw: string | undefined,
  allowFake: boolean,
  problems: string[],
): ConnectorName[] {
  const names = (raw ?? '')
    .split(',')
    .map((n) => n.trim())
    .filter((n) => n !== '');
  const result: ConnectorName[] = [];
  for (const name of new Set(names)) {
    if (!(KNOWN_CONNECTORS as readonly string[]).includes(name)) {
      problems.push(
        `BUDGEDINO_CONNECTORS: unknown connector (known: ${KNOWN_CONNECTORS.join(', ')})`,
      );
    } else if (name === 'fake' && !allowFake) {
      problems.push(
        'BUDGEDINO_CONNECTORS: "fake" is only allowed when NODE_ENV is not "production" or BUDGEDINO_ALLOW_FAKE=1',
      );
    } else {
      result.push(name as ConnectorName);
    }
  }
  return result;
}

/** Reads and validates the server configuration; throws {@link ConfigError} listing every problem. */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const problems: string[] = [];
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      problems.push(`${issue.path.join('.') || 'env'}: ${issue.message}`);
    }
  }
  let master: MasterKey | undefined;
  try {
    master = loadMasterKey(env);
  } catch (e) {
    if (!(e instanceof MasterKeyError)) throw e;
    problems.push(`BUDGEDINO_MASTER_KEY: ${e.message}`);
  }
  const trustProxy = parseTrustProxy(env['BUDGEDINO_TRUST_PROXY'], problems);
  const allowFake = env['NODE_ENV'] !== 'production' || env['BUDGEDINO_ALLOW_FAKE'] === '1';
  const connectors = parseConnectors(env['BUDGEDINO_CONNECTORS'], allowFake, problems);
  const productId = parsed.success ? parsed.data.BUDGEDINO_FINTS_PRODUCT_ID?.trim() : undefined;
  if (connectors.includes('fints') && !productId) {
    problems.push('BUDGEDINO_FINTS_PRODUCT_ID: is required when the "fints" connector is enabled');
  }
  if (problems.length > 0 || !parsed.success || !master) throw new ConfigError(problems);
  return {
    databaseUrl: parsed.data.DATABASE_URL,
    master,
    port: parsed.data.PORT,
    host: parsed.data.HOST,
    trustProxy,
    maxConcurrentSyncs: parsed.data.BUDGEDINO_MAX_CONCURRENT_SYNCS,
    connectors,
    ...(connectors.includes('fints') && productId
      ? {
          fints: {
            productId,
            productVersion: parsed.data.BUDGEDINO_FINTS_PRODUCT_VERSION,
          },
        }
      : {}),
  };
}

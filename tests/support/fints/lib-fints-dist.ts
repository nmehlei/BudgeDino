import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Loads a (patched) lib-fints dist module by path. `lib-fints` is only resolvable from
 * `src/server`, and it exports neither the interactions nor the CAMT parser.
 */
export async function libFintsDist<T = Record<string, unknown>>(file: string): Promise<T> {
  const dist = new URL('../../../src/server/node_modules/lib-fints/dist/', import.meta.url);
  return (await import(pathToFileURL(fileURLToPath(new URL(file, dist))).href)) as T;
}

type DatCtor = new (name: string) => { encode(value: Date): string };

const { Dat } = await libFintsDist<{ Dat: DatCtor }>('dataElements/Dat.js');

/** The YYYY-MM-DD lib-fints puts on the wire for a Date (its `Dat` element, as HKKAZ/HKCAZ use). */
export function wireIso(d: unknown): string {
  const e = new Dat('d').encode(d as Date);
  return `${e.slice(0, 4)}-${e.slice(4, 6)}-${e.slice(6, 8)}`;
}

/** Runs `fn` with the host time zone switched (Node re-reads `process.env.TZ` at runtime). */
export async function withTimeZone<T>(tz: string, fn: () => Promise<T> | T): Promise<T> {
  const previous = process.env['TZ'];
  process.env['TZ'] = tz;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env['TZ'];
    else process.env['TZ'] = previous;
  }
}

export const TEST_ZONES = [
  'UTC',
  'Europe/Berlin',
  'Pacific/Kiritimati',
  'America/Los_Angeles',
] as const;

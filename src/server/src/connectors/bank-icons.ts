import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { bankIcons } from '../db/schema.js';
import type { Logger } from '../observability/logger.js';
import { safeErrorInfo } from '../observability/redact.js';
import { FINTS_BANKS } from './fints/banks.js';

export interface BankIcon {
  contentType: string;
  data: Buffer;
}

export interface BankIconStore {
  get(bank: string): Promise<(BankIcon & { fetchedAt: Date }) | null>;
  put(bank: string, icon: BankIcon, fetchedAt: Date): Promise<void>;
}

export interface BankIconService {
  /** The cached or freshly fetched logo; null for an unknown bank or when it cannot be fetched. */
  get(bank: string): Promise<BankIcon | null>;
}

export const ICON_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** After a failed fetch without any cached copy, do not try again for this long. */
export const FAILURE_BACKOFF_MS = 10 * 60 * 1000;
export const MAX_ICON_BYTES = 256 * 1024;
const FETCH_TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 3;

/**
 * The raster type a buffer really is, from its magic bytes (PNG, JPEG, GIF, WebP); null for anything else.
 * Raster only: SVG and HTML can carry script. The upstream `Content-Type` is never trusted.
 */
export function sniffIconType(data: Uint8Array): string | null {
  const at = (i: number) => data[i];
  const ascii = (from: number, text: string) =>
    data.length >= from + text.length &&
    [...text].every((ch, i) => at(from + i) === ch.charCodeAt(0));
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (data.length >= 8 && png.every((b, i) => at(i) === b)) return 'image/png';
  if (data.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  return null;
}

/** Reads the body, aborting as soon as it exceeds `max` bytes. */
async function readLimited(res: Response, max: number): Promise<Buffer> {
  const body = res.body;
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new Error('icon too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export function createDbBankIconStore(db: Db): BankIconStore {
  return {
    async get(bank) {
      const [row] = await db.select().from(bankIcons).where(eq(bankIcons.bank, bank));
      return row
        ? { contentType: row.contentType, data: row.data, fetchedAt: row.fetchedAt }
        : null;
    },
    async put(bank, icon, fetchedAt) {
      await db
        .insert(bankIcons)
        .values({ bank, contentType: icon.contentType, data: icon.data, fetchedAt })
        .onConflictDoUpdate({
          target: bankIcons.bank,
          set: { contentType: icon.contentType, data: icon.data, fetchedAt },
        });
    },
  };
}

export interface BankIconOptions {
  store: BankIconStore;
  logger: Logger;
  now: () => Date;
  /** Replaces the global `fetch` (tests: no network). */
  fetchImpl?: typeof fetch;
  /** Allow-list of `bank -> { iconUrl }`; default: the FinTS catalog. Never derived from user input. */
  catalog?: Readonly<Record<string, { iconUrl: string }>>;
}

/**
 * Serves bank logos from the server cache, fetching lazily from the fixed `iconUrl` of the catalog. The bank
 * id from the request only selects a catalog entry; it never becomes part of a URL (no SSRF).
 */
export function createBankIconService(options: BankIconOptions): BankIconService {
  const { store, logger, now } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const catalog: Readonly<Record<string, { iconUrl: string }>> = options.catalog ?? FINTS_BANKS;
  const failedUntil = new Map<string, number>();
  const inFlight = new Map<string, Promise<BankIcon | null>>();

  async function download(allowedUrl: string): Promise<BankIcon> {
    const allowed = new URL(allowedUrl);
    let url = allowed;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const res = await fetchImpl(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { accept: 'image/png,image/*;q=0.8', 'user-agent': 'Mozilla/5.0 (BudgeDino)' },
      });
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => undefined);
        const location = res.headers.get('location');
        if (!location) throw new Error('redirect without location');
        const next = new URL(location, url);
        // same official host only, over https
        if (next.protocol !== 'https:' || next.host !== allowed.host) {
          throw new Error('redirect leaves the allow-listed host');
        }
        url = next;
        continue;
      }
      if (!res.ok) throw new Error(`unexpected status ${res.status}`);
      const declared = Number(res.headers.get('content-length') ?? '0');
      if (declared > MAX_ICON_BYTES) {
        await res.body?.cancel().catch(() => undefined);
        throw new Error('icon too large');
      }
      const data = await readLimited(res, MAX_ICON_BYTES);
      if (data.length === 0) throw new Error('icon size invalid');
      const contentType = sniffIconType(data);
      if (!contentType) throw new Error('unsupported image format');
      return { contentType, data };
    }
    throw new Error('too many redirects');
  }

  async function load(bank: string, iconUrl: string): Promise<BankIcon | null> {
    const cached = await store.get(bank);
    const at = now();
    // A stored row is only served when its bytes are still a known raster format (rows from before the
    // magic-byte check are re-derived or dropped); its type always comes from the bytes.
    const sniffed = cached ? sniffIconType(cached.data) : null;
    const usable = cached && sniffed ? { ...cached, contentType: sniffed } : null;
    if (usable && at.getTime() - usable.fetchedAt.getTime() < ICON_TTL_MS) return usable;
    if ((failedUntil.get(bank) ?? 0) > at.getTime()) return usable;
    try {
      const icon = await download(iconUrl);
      await store.put(bank, icon, at);
      failedUntil.delete(bank);
      return icon;
    } catch (err) {
      logger.warn({ bank, error: safeErrorInfo(err) }, 'bank icon: fetch failed');
      // back off in every case, also with a stale copy to serve (no refetch per request)
      failedUntil.set(bank, at.getTime() + FAILURE_BACKOFF_MS);
      // a stale copy is better than none
      return usable;
    }
  }

  return {
    async get(bank) {
      if (!Object.hasOwn(catalog, bank)) return null;
      const entry = catalog[bank];
      if (!entry) return null;
      let running = inFlight.get(bank);
      if (!running) {
        running = load(bank, entry.iconUrl).finally(() => inFlight.delete(bank));
        inFlight.set(bank, running);
      }
      return running;
    },
  };
}

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
/** Raster only: SVG can carry script. */
const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

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
      const contentType = (res.headers.get('content-type') ?? '')
        .split(';')[0]
        ?.trim()
        .toLowerCase();
      if (!contentType || !ALLOWED_TYPES.has(contentType))
        throw new Error('unsupported content type');
      const declared = Number(res.headers.get('content-length') ?? '0');
      if (declared > MAX_ICON_BYTES) throw new Error('icon too large');
      const data = Buffer.from(await res.arrayBuffer());
      if (data.length === 0 || data.length > MAX_ICON_BYTES) throw new Error('icon size invalid');
      return { contentType, data };
    }
    throw new Error('too many redirects');
  }

  async function load(bank: string, iconUrl: string): Promise<BankIcon | null> {
    const cached = await store.get(bank);
    const at = now();
    if (cached && at.getTime() - cached.fetchedAt.getTime() < ICON_TTL_MS) return cached;
    if ((failedUntil.get(bank) ?? 0) > at.getTime()) return cached ?? null;
    try {
      const icon = await download(iconUrl);
      await store.put(bank, icon, at);
      failedUntil.delete(bank);
      return icon;
    } catch (err) {
      logger.warn({ bank, error: safeErrorInfo(err) }, 'bank icon: fetch failed');
      // a stale copy is better than none
      if (cached) return cached;
      failedUntil.set(bank, at.getTime() + FAILURE_BACKOFF_MS);
      return null;
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

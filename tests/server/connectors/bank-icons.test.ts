import { describe, expect, it, vi } from 'vitest';
import {
  FAILURE_BACKOFF_MS,
  ICON_TTL_MS,
  MAX_ICON_BYTES,
  createBankIconService,
  type BankIcon,
  type BankIconStore,
} from '@budgedino/server/connectors/bank-icons';
import { FINTS_BANKS } from '@budgedino/server/connectors/fints/banks';
import { createLogger } from '@budgedino/server/observability/logger';

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

function memoryStore(): BankIconStore & { rows: Map<string, BankIcon & { fetchedAt: Date }> } {
  const rows = new Map<string, BankIcon & { fetchedAt: Date }>();
  return {
    rows,
    get: async (bank) => rows.get(bank) ?? null,
    put: async (bank, icon, fetchedAt) => void rows.set(bank, { ...icon, fetchedAt }),
  };
}

const png = (init: ResponseInit = {}, body: Uint8Array = PNG) =>
  new Response(body as unknown as ConstructorParameters<typeof Response>[0], {
    status: 200,
    headers: { 'content-type': 'image/png' },
    ...init,
  });

function setup(responses: (() => Response | Promise<Response>)[]) {
  let nowMs = Date.parse('2026-11-10T10:00:00Z');
  const queue = [...responses];
  const calls: string[] = [];
  const fetchImpl = vi.fn((input: URL | string | Request) => {
    calls.push(String(input instanceof Request ? input.url : input));
    const next = queue.shift();
    if (!next) throw new Error('unexpected fetch');
    return Promise.resolve(next());
  }) as unknown as typeof fetch;
  const store = memoryStore();
  const service = createBankIconService({
    store,
    fetchImpl,
    logger: createLogger({ level: 'silent' }),
    now: () => new Date(nowMs),
  });
  return {
    service,
    store,
    calls,
    advance: (ms: number) => void (nowMs += ms),
    fetchImpl: fetchImpl as unknown as ReturnType<typeof vi.fn>,
  };
}

describe('bank icon service', () => {
  it('fetches the allow-listed URL of the catalog and caches the image', async () => {
    const t = setup([() => png()]);
    const icon = await t.service.get('dkb');
    expect(icon).toMatchObject({ contentType: 'image/png' });
    expect(icon?.data.equals(PNG)).toBe(true);
    expect(t.calls).toEqual([FINTS_BANKS.dkb.iconUrl]);
    expect(t.store.rows.has('dkb')).toBe(true);
    // served from the cache within the TTL: no second fetch
    await t.service.get('dkb');
    expect(t.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('never fetches for unknown banks or hostile ids (no user input in the URL)', async () => {
    const t = setup([]);
    for (const bank of [
      'fake',
      'unknown',
      'http://evil.example/x',
      '../../etc/passwd',
      '__proto__',
      'constructor',
      'toString',
    ]) {
      expect(await t.service.get(bank)).toBeNull();
    }
    expect(t.fetchImpl).not.toHaveBeenCalled();
  });

  it('refreshes after the 30 day TTL and serves the stale copy when the refresh fails', async () => {
    const t = setup([() => png(), () => new Response('nope', { status: 500 })]);
    await t.service.get('dkb');
    t.advance(ICON_TTL_MS + 1000);
    const stale = await t.service.get('dkb');
    expect(stale?.data.equals(PNG)).toBe(true);
    expect(t.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('returns null on a failed fetch and backs off before trying again', async () => {
    const t = setup([() => new Response('nope', { status: 503 }), () => png()]);
    expect(await t.service.get('dkb')).toBeNull();
    expect(await t.service.get('dkb')).toBeNull();
    expect(t.fetchImpl).toHaveBeenCalledTimes(1);
    t.advance(FAILURE_BACKOFF_MS + 1000);
    expect(await t.service.get('dkb')).not.toBeNull();
  });

  it('treats network errors and timeouts as a failed fetch', async () => {
    const t = setup([
      () => {
        throw new Error('ECONNRESET');
      },
    ]);
    expect(await t.service.get('comdirect')).toBeNull();
  });

  it('follows a redirect on the same https host only', async () => {
    const same = setup([
      () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://www.dkb.de/apple-touch-icon.png?x=1' },
        }),
      () => png(),
    ]);
    expect(await same.service.get('dkb')).not.toBeNull();
    expect(same.calls[1]).toBe('https://www.dkb.de/apple-touch-icon.png?x=1');

    for (const location of [
      'https://evil.example/icon.png',
      'http://www.dkb.de/icon.png',
      'https://www.dkb.de.evil.example/icon.png',
      'http://169.254.169.254/latest/meta-data',
    ]) {
      const t = setup([() => new Response(null, { status: 302, headers: { location } })]);
      expect(await t.service.get('dkb'), location).toBeNull();
      expect(t.fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it('stops after too many redirects', async () => {
    const hop = () =>
      new Response(null, { status: 302, headers: { location: 'https://www.dkb.de/a' } });
    const t = setup([hop, hop, hop, hop, hop]);
    expect(await t.service.get('dkb')).toBeNull();
  });

  it('rejects non-raster content types, oversize and empty bodies', async () => {
    const svg = setup([() => png({ headers: { 'content-type': 'image/svg+xml' } })]);
    expect(await svg.service.get('dkb')).toBeNull();
    const html = setup([() => png({ headers: { 'content-type': 'text/html' } })]);
    expect(await html.service.get('dkb')).toBeNull();
    const big = setup([() => png({}, new Uint8Array(MAX_ICON_BYTES + 1))]);
    expect(await big.service.get('dkb')).toBeNull();
    const empty = setup([() => png({}, new Uint8Array(0))]);
    expect(await empty.service.get('dkb')).toBeNull();
  });

  it('coalesces concurrent requests into one fetch', async () => {
    const t = setup([() => png()]);
    const [a, b] = await Promise.all([t.service.get('dkb'), t.service.get('dkb')]);
    expect(a).toEqual(b);
    expect(t.fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('bank catalog', () => {
  it('only lists https icon URLs on the bank domains', () => {
    for (const bank of Object.values(FINTS_BANKS)) {
      const url = new URL(bank.iconUrl);
      expect(url.protocol).toBe('https:');
      expect(url.search).toBe('');
    }
  });
});

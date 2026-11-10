import { ApiClientError, type ApiError } from '../errors';
import { createApiClient, parseRetryAfter } from '../client';

const BASE = 'https://budget.example.test/';

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function setup(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fetchImpl = jest.fn(async (url: string | URL | Request, init?: RequestInit) =>
    respond(String(url), init ?? {}),
  );
  const onUnauthorized = jest.fn();
  const getToken = jest.fn(() => 'tok-123');
  const client = createApiClient({
    baseUrl: BASE,
    getToken,
    onUnauthorized,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  return { client, fetchImpl, onUnauthorized, getToken };
}

async function errorOf(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof ApiClientError) return e.error;
    throw e;
  }
  throw new Error('expected the request to fail');
}

const account = {
  id: 'a1',
  connectorId: 'c1',
  disconnected: false,
  ownerMemberId: 'm1',
  name: 'Giro',
  ibanMasked: '****1234',
  kind: 'checking',
  currency: 'EUR',
  visibility: 'household',
  countsTowardBudgets: true,
  balanceMinor: '12345',
  isOwner: true,
};

describe('api client', () => {
  it('sends the Bearer token and returns the parsed response', async () => {
    const { client, fetchImpl } = setup(() => json({ accounts: [account] }));
    const res = await client.listAccounts();
    expect(res.accounts[0]?.name).toBe('Giro');
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://budget.example.test/api/v1/accounts');
    expect((init?.headers as Record<string, string>)['authorization']).toBe('Bearer tok-123');
  });

  it('sends no Authorization header without a token and a JSON body for writes', async () => {
    const fetchImpl = jest.fn(async () => json({ sessionToken: 's' }));
    const client = createApiClient({
      baseUrl: BASE,
      getToken: () => null,
      onUnauthorized: jest.fn(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.login({ email: 'a@b.c', password: 'pw', deviceName: 'Pixel' });
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>)['authorization']).toBeUndefined();
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({
      email: 'a@b.c',
      password: 'pw',
      deviceName: 'Pixel',
    });
  });

  it('encodes query parameters and skips undefined ones', async () => {
    const { client, fetchImpl } = setup(() => json({ transactions: [], nextCursor: null }));
    await client.listTransactions({ accountId: undefined, limit: 20, from: '2026-11-01' });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      'https://budget.example.test/api/v1/transactions?limit=20&from=2026-11-01',
    );
  });

  it('on 401 calls onUnauthorized and throws unauthorized', async () => {
    const { client, onUnauthorized } = setup(() =>
      json({ error: 'unauthorized', message: 'no' }, { status: 401 }),
    );
    expect(await errorOf(client.listAccounts())).toEqual({ kind: 'unauthorized' });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('waits for onUnauthorized (the wipe) before throwing', async () => {
    const order: string[] = [];
    const client = createApiClient({
      baseUrl: BASE,
      getToken: () => 't',
      onUnauthorized: async () => {
        await Promise.resolve();
        order.push('wiped');
      },
      fetchImpl: (async () => json({}, { status: 401 })) as unknown as typeof fetch,
    });
    await client.listAccounts().catch(() => order.push('thrown'));
    expect(order).toEqual(['wiped', 'thrown']);
  });

  it('parses Retry-After on 429', async () => {
    const { client, onUnauthorized } = setup(() =>
      json(
        { error: 'rate_limited', message: 'slow down' },
        { status: 429, headers: { 'retry-after': '42' } },
      ),
    );
    expect(await errorOf(client.listAccounts())).toEqual({
      kind: 'rate_limited',
      retryAfterSec: 42,
    });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('falls back to 60 s when Retry-After is missing or garbage', async () => {
    const { client } = setup(() => json({}, { status: 429, headers: { 'retry-after': 'soon' } }));
    expect(await errorOf(client.listAccounts())).toEqual({
      kind: 'rate_limited',
      retryAfterSec: 60,
    });
  });

  it('maps a network failure to network and does not sign out', async () => {
    const { client, onUnauthorized } = setup(() => {
      throw new TypeError('Network request failed https://budget.example.test/secret');
    });
    const err = await client.listAccounts().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiClientError);
    expect((err as ApiClientError).error).toEqual({ kind: 'network' });
    expect((err as ApiClientError).message).not.toContain('budget.example.test');
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('maps an aborted (timed out) request to network', async () => {
    const client = createApiClient({
      baseUrl: BASE,
      getToken: () => 't',
      onUnauthorized: jest.fn(),
      timeoutMs: 5,
      fetchImpl: ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        })) as unknown as typeof fetch,
    });
    expect(await errorOf(client.listAccounts())).toEqual({ kind: 'network' });
  });

  it('maps a response failing the schema to schema_mismatch, never returning raw data', async () => {
    const { client } = setup(() => json({ accounts: [{ ...account, kind: 'bogus' }] }));
    expect(await errorOf(client.listAccounts())).toEqual({ kind: 'schema_mismatch' });
  });

  it('maps a non-JSON 200 body to schema_mismatch', async () => {
    const { client } = setup(() => new Response('<html>proxy</html>', { status: 200 }));
    expect(await errorOf(client.listAccounts())).toEqual({ kind: 'schema_mismatch' });
  });

  it('returns validation issues for 400', async () => {
    const { client } = setup(() =>
      json(
        { error: 'validation', message: 'bad', issues: [{ path: 'name', message: 'required' }] },
        { status: 400 },
      ),
    );
    expect(
      await errorOf(
        client.createBudget({
          name: '',
          categoryIds: ['c'],
          periodKind: 'monthly',
          amount: { minor: '1', currency: 'EUR' },
        }),
      ),
    ).toEqual({ kind: 'validation', issues: [{ path: 'name', message: 'required' }] });
  });

  it('maps 5xx and other unexpected statuses to server', async () => {
    const { client } = setup(() => json({ error: 'x', message: 'y' }, { status: 503 }));
    expect(await errorOf(client.listAccounts())).toEqual({ kind: 'server', status: 503 });
    const { client: c2 } = setup(() => json({ error: 'x', message: 'y' }, { status: 404 }));
    expect(await errorOf(c2.getHome())).toEqual({ kind: 'server', status: 404 });
  });

  it('handles 204 responses without a body', async () => {
    const { client, fetchImpl } = setup(() => new Response(null, { status: 204 }));
    await expect(client.revokeSession('s/1')).resolves.toBeUndefined();
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain('/auth/sessions/s%2F1');
  });
  it('still throws unauthorized when onUnauthorized itself throws', async () => {
    const client = createApiClient({
      baseUrl: BASE,
      getToken: () => 't',
      onUnauthorized: () => {
        throw new Error('cache.clear failed');
      },
      fetchImpl: (async () => json({}, { status: 401 })) as unknown as typeof fetch,
    });
    expect(await errorOf(client.listAccounts())).toEqual({ kind: 'unauthorized' });
  });

  it('maps a getToken failure to unauthorized and wipes the session', async () => {
    const onUnauthorized = jest.fn();
    const fetchImpl = jest.fn();
    const client = createApiClient({
      baseUrl: BASE,
      getToken: () => Promise.reject(new Error('keystore invalidated')),
      onUnauthorized,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await errorOf(client.listAccounts())).toEqual({ kind: 'unauthorized' });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps the timeout running while the body is read', async () => {
    const client = createApiClient({
      baseUrl: BASE,
      getToken: () => 't',
      onUnauthorized: jest.fn(),
      timeoutMs: 5,
      fetchImpl: (async (_url: string, init: RequestInit) => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: () =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              reject(new Error('aborted'));
            });
          }),
      })) as unknown as typeof fetch,
    });
    expect(await errorOf(client.listAccounts())).toEqual({ kind: 'network' });
  });
});

describe('connection management and net worth calls', () => {
  it('deleteConnector sends DELETE with the mode and expects no body', async () => {
    const { client, fetchImpl } = setup(() => new Response(null, { status: 204 }));
    await expect(client.deleteConnector('c 1', 'purge')).resolves.toBeUndefined();
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://budget.example.test/api/v1/connectors/c%201?mode=purge');
    expect(init?.method).toBe('DELETE');
  });

  it('renameConnector sends PATCH {displayName} and parses the connector', async () => {
    const info = {
      id: 'c1',
      type: 'fints',
      status: 'ok',
      isOwner: true,
      bank: 'dkb',
      displayName: 'Anna',
      experimental: false,
      lastSuccessAt: null,
      lastErrorCode: null,
      consentExpiresAt: null,
    };
    const { client, fetchImpl } = setup(() => json(info));
    expect((await client.renameConnector('c1', 'Anna')).displayName).toBe('Anna');
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ displayName: 'Anna' });
  });

  it('bankIconSource returns the icon URL with the auth header, or null without a token', async () => {
    const { client } = setup(() => json({}));
    expect(await client.bankIconSource('dkb')).toEqual({
      uri: 'https://budget.example.test/api/v1/banks/dkb/icon',
      headers: { authorization: 'Bearer tok-123' },
    });
    const signedOut = createApiClient({
      baseUrl: BASE,
      getToken: () => null,
      onUnauthorized: jest.fn(),
    });
    expect(await signedOut.bankIconSource('dkb')).toBeNull();
  });

  it('getNetWorth parses the response', async () => {
    const body = {
      baseCurrency: 'EUR',
      total: { minor: '100', currency: 'EUR' },
      fxMissing: false,
      groups: [],
    };
    const { client, fetchImpl } = setup(() => json(body));
    expect(await client.getNetWorth()).toEqual(body);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      'https://budget.example.test/api/v1/net-worth',
    );
  });
});

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-11-10T12:00:00Z');
  it('reads delta-seconds', () => {
    expect(parseRetryAfter('42', now)).toBe(42);
  });
  it('reads an HTTP date', () => {
    expect(parseRetryAfter('Tue, 10 Nov 2026 12:01:30 GMT', now)).toBe(90);
  });
  it('clamps past dates to 0', () => {
    expect(parseRetryAfter('Tue, 10 Nov 2026 11:00:00 GMT', now)).toBe(0);
  });
  it('falls back to 60 for garbage such as 12abc, empty and missing', () => {
    expect(parseRetryAfter('12abc', now)).toBe(60);
    expect(parseRetryAfter('', now)).toBe(60);
    expect(parseRetryAfter(null, now)).toBe(60);
  });
  it('caps at one hour', () => {
    expect(parseRetryAfter('999999', now)).toBe(3600);
  });
});

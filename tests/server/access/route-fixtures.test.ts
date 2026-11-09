import { describe, expect, it } from 'vitest';
import { resolveRouteUrl } from '../../support/route-fixtures.js';

const seed = { hiddenAccountId: 'acc-1', hiddenTransactionId: 'tx-1', hiddenMemberId: 'm-1' };

describe('resolveRouteUrl', () => {
  it('leaves parameterless routes alone', () => {
    expect(resolveRouteUrl('/api/v1/accounts', seed, {})).toBe('/api/v1/accounts');
  });

  it('substitutes registered parameters', () => {
    const fixtures = {
      '/x/:accountId/y/:id': {
        ':accountId': () => 'A',
        ':id': (s: typeof seed) => s.hiddenTransactionId,
      },
    };
    expect(resolveRouteUrl('/x/:accountId/y/:id', seed, fixtures)).toBe('/x/A/y/tx-1');
  });

  it('fails when a path parameter has no fixture', () => {
    expect(() => resolveRouteUrl('/x/:id', seed, {})).toThrow(/route-fixtures\.ts/);
    expect(() =>
      resolveRouteUrl('/x/:id/:other', seed, { '/x/:id/:other': { ':id': () => '1' } }),
    ).toThrow(/:other/);
  });
});

/**
 * Path-parameter substitutions for the "every GET route" visibility harness
 * (tests/server/access/visibility.int.test.ts).
 *
 * RULE: adding a GET route with a path parameter requires an entry here. The harness fails when a
 * registered GET route has a parameter without a substitution, so a new route can never silently
 * escape the owner-only visibility check.
 *
 * Keys are the registered route URL (including the `/api/v1` prefix), e.g. `/api/v1/accounts/:id`.
 * Each entry maps the `:param` to a value derived from the seeded canary data (the id of member
 * B's owner-only account, one of its transactions, ...), so the harness probes the hidden rows.
 */
export interface RouteFixtureSeed {
  hiddenAccountId: string;
  hiddenTransactionId: string;
  hiddenMemberId: string;
}

export type RouteFixtures = Record<string, Record<string, (seed: RouteFixtureSeed) => string>>;

export const ROUTE_FIXTURES: RouteFixtures = {
  // '/api/v1/accounts/:accountId/transactions': { ':accountId': (s) => s.hiddenAccountId },
};

/**
 * GET routes exempt from the owner positive control (B, a plain member, must get 2xx, and
 * parameterised routes must return one of B's canaries). Keep this empty unless a route genuinely
 * cannot satisfy it, e.g. an admin-only route; the value is the reason. Exempt routes are still
 * probed as the other member in the leak sweep.
 */
export const OWNER_POSITIVE_CONTROL_EXEMPT: Record<string, string> = {};

/** Substitutes every `:param` of a route URL, throwing when a parameter has no fixture. */
export function resolveRouteUrl(
  url: string,
  seed: RouteFixtureSeed,
  fixtures: RouteFixtures = ROUTE_FIXTURES,
): string {
  return url.replace(/:([A-Za-z0-9_]+)/g, (_m, name: string) => {
    const make = fixtures[url]?.[`:${name}`];
    if (!make) {
      throw new Error(
        `GET route ${url} has path parameter :${name} without an entry in tests/support/route-fixtures.ts`,
      );
    }
    return make(seed);
  });
}

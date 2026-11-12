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
  /** An open challenge of member B's connector. */
  hiddenChallengeId: string;
}

export type RouteFixtures = Record<string, Record<string, (seed: RouteFixtureSeed) => string>>;

export const ROUTE_FIXTURES: RouteFixtures = {
  // '/api/v1/accounts/:accountId/transactions': { ':accountId': (s) => s.hiddenAccountId },
  '/api/v1/challenges/:id': { ':id': (s) => s.hiddenChallengeId },
  // An unknown bank id: the harness must never trigger a real fetch of a bank logo (404, no network).
  '/api/v1/banks/:bank/icon': { ':bank': () => 'unknown' },
};

/**
 * GET routes exempt from the owner positive control (B, a plain member, must get 2xx, and
 * parameterised routes must return one of B's canaries). Keep this empty unless a route genuinely
 * cannot satisfy it, e.g. an admin-only route; the value is the reason. Exempt routes are still
 * probed as the other member in the leak sweep.
 */
export const OWNER_POSITIVE_CONTROL_EXEMPT: Record<string, string> = {
  // Returns only `{ status }`: by design it carries no account data, so there is no canary to find. The
  // owner's 2xx and the other member's 404 are asserted in tests/server/connectors/challenge.int.test.ts.
  '/api/v1/challenges/:id': 'status-only response, no canary data (see challenge.int.test.ts)',
  // Public bank artwork, not account data; the harness uses an unknown bank so it never touches the network.
  // The 200 and 404 cases are asserted in tests/server/connectors/bank-icons.int.test.ts.
  '/api/v1/banks/:bank/icon': 'static bank logo, no canary data (see bank-icons.int.test.ts)',
  // Admin-only: the harness's owner (member B) is a plain member and gets 403 by design. Pending-invite
  // listing and the 403/404/409 cases are asserted in tests/server/households/members.int.test.ts.
  '/api/v1/households/invites': 'admin-only, member B gets 403 (see members.int.test.ts)',
};

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

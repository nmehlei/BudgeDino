# Spec: Household and access

- Status: living spec (source of truth for behaviour)
- Origin: [founding design](2026-11-08-budgedino-design.md) §3. **[owner]** = decided by the owner,
  **[call]** = AI's call, may be challenged.

## Model

- A **household** has **members** who join by invitation only (no open registration). **[call]**
- Members have personal accounts and share joint accounts. **[owner]**
- Each account has a **visibility** setting: `household` (default) or `owner-only`. Toggleable in the app
  in v1. **[owner]** Visibility is enforced on the server; hidden data never leaves the server to other
  members. **[call]**
- Roles: `admin` (manages members, invites, budgets, categories) and `member`. Members may create rules (R18);
  a rule only affects accounts visible to its creator or counting toward budgets ([categorization.md](categorization.md)). **[call]**
- **Connectors belong to the member who creates them.** Each member connects their own banks with
  their own credentials on their own phone; TAN confirmations, consent-renewal and sync-failure
  notifications go to that member. Joint accounts are connected by one member and shared via
  visibility. **[call]**
- Admins are **not** exempt from visibility: an `owner-only` account is invisible to everyone but its
  owner, admins included. **[call]**

## Visibility enforcement and accounts API

- `visibleAccountIds(db, auth)` is the single gate: accounts of the caller's household with
  `visibility='household'`, plus every account the caller owns. Repository reads of accounts,
  transactions, splits and balances require its result, so no route can read them unfiltered.
- `GET /accounts` lists the visible accounts with decrypted `name`, masked IBAN (`•••• 3000`: last 4
  characters) and balance. These are never returned to members who may not see the account.
- `PATCH /accounts/:id` `{ visibility?, countsTowardBudgets? }` is owner only; anyone else, admins
  included, gets `404` (indistinguishable from a missing account). Switching to `owner_only` sets
  `countsTowardBudgets=false` unless the request passes `countsTowardBudgets` explicitly. Takes effect
  immediately on every endpoint.
- **R17:** `POST /connectors` accepts `accountDefaults: { visibility?, countsTowardBudgets? }` (stored plain on
  the connector). Accounts discovered for that connector start with those values, so an `owner_only` connector's
  accounts and transactions are never visible to anyone else at any point. `owner_only` without
  `countsTowardBudgets` defaults to `false`; without `accountDefaults` accounts are `household` and counting.
- Sessions expire after 90 days idle and 365 days absolute lifetime ([security.md](security.md)).
  **[call]**
- Enforced by a canary test that probes every registered GET route as another member
  (`tests/server/access/visibility.int.test.ts`, fixtures in `tests/support/route-fixtures.ts`).

## Related

- Budget inclusion of accounts (`countsTowardBudgets`): [budgets.md](budgets.md)
- Authentication and sessions: [security.md](security.md)

## Bootstrap, invites and authentication

- `budgedino bootstrap --household <name> --timezone <iana>` creates the household, its data key, the
  default categories (`src/server/src/categorization/defaults.ts`) and prints a one-time admin invite
  token. `budgedino invite --household <id> --role member|admin` prints further invites. Invites live
  7 days and are single use. Admins can also create invites over `POST /households/invites`; members get 403. Join flow: `register` -> authenticator app -> `register/confirm` ([security.md](security.md)).
- `budgedino init-key` prints a new master key once on stdout and requires typing its last 6
  characters; `budgedino rotate-master-key --server-stopped` re-wraps all keys (R19: it prints the "stop all running servers
  first" warning before doing anything and refuses without the flag; old key from `BUDGEDINO_MASTER_KEY[_FILE]`,
  new key from `BUDGEDINO_NEW_MASTER_KEY[_FILE]`).
- **Passkeys (extension point, not in P1).** Credentials are password + TOTP today. A later plan adds
  WebAuthn passkeys as an alternative first factor: a `passkeys` table keyed by member, an additional
  login route next to `POST /auth/login` that ends in the same `createSession`, and no changes to
  sessions, guards or `AuthContext`.

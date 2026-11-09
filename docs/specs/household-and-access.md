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
- Roles: `admin` (manages members, invites, budgets, categories, shared rules) and `member`. **[call]**
- **Connectors belong to the member who creates them.** Each member connects their own banks with
  their own credentials on their own phone; TAN confirmations, consent-renewal and sync-failure
  notifications go to that member. Joint accounts are connected by one member and shared via
  visibility. **[call]**
- Admins are **not** exempt from visibility: an `owner-only` account is invisible to everyone but its
  owner, admins included. **[call]**

## Related

- Budget inclusion of accounts (`countsTowardBudgets`): [budgets.md](budgets.md)
- Authentication and sessions: [security.md](security.md)

## Bootstrap, invites and authentication

- `budgedino bootstrap --household <name> --timezone <iana>` creates the household, its data key, the
  default categories (`src/server/src/categorization/defaults.ts`) and prints a one-time admin invite
  token. `budgedino invite --household <id> --role member|admin` prints further invites. Invites live
  7 days and are single use. Admins can also create invites over `POST /households/invites`; members get
  403. Join flow: `register` -> authenticator app -> `register/confirm` ([security.md](security.md)).
- `budgedino init-key` prints a new master key once on stdout and requires typing its last 6
  characters; `budgedino rotate-master-key` re-wraps all keys (old key from `BUDGEDINO_MASTER_KEY[_FILE]`,
  new key from `BUDGEDINO_NEW_MASTER_KEY[_FILE]`).
- **Passkeys (extension point, not in P1).** Credentials are password + TOTP today. A later plan adds
  WebAuthn passkeys as an alternative first factor: a `passkeys` table keyed by member, an additional
  login route next to `POST /auth/login` that ends in the same `createSession`, and no changes to
  sessions, guards or `AuthContext`.

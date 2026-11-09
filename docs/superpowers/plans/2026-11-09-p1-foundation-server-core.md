# P1 — Foundation & Server Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A tested TypeScript monorepo with spec-driven docs and a server that authenticates household members, syncs a (fake) connector with typed challenges, stores everything encrypted, categorizes transactions and serves budget progress for the home screen.

**Architecture:** pnpm monorepo. `src/shared` holds pure domain logic (money, periods, zod schemas). `src/server` is a Fastify API over PostgreSQL (Drizzle) with application-level envelope encryption, pg-boss background jobs, and a pluggable connector interface. Real connectors (FinTS: plan P2) and the Android app (plan P3) build on the interfaces defined here.

**Tech Stack:** Node.js (current active LTS), TypeScript (strict), pnpm workspaces, Fastify, zod + `fastify-type-provider-zod` + `@fastify/swagger`, Drizzle ORM + drizzle-kit, PostgreSQL 17+, pg-boss, `@node-rs/argon2`, `otplib`, pino, OpenTelemetry SDK, Vitest, fast-check, Testcontainers. All at latest stable versions at implementation time.

**Spec:** `docs/specs/2026-11-08-budgedino-design.md` (founding design). After Task 1, per-area specs live in `docs/specs/<area>.md` and take precedence.

## Global Constraints

- TypeScript throughout; strict mode; no `any` in domain code.
- Money: integer minor units + ISO 4217 currency; never floating point.
- Read-only bank access; no payment initiation.
- Sensitive fields (credentials, PINs, tokens, broker sessions, counterparty, purpose, amounts, balances, holdings, account names/IBANs) are encrypted at application level; the master key never lives in the database.
- Logs, traces and notification payloads never contain amounts, payees, IBANs or credentials.
- Visibility is enforced on the server; `owner-only` accounts are invisible to everyone but their owner, admins included.
- Connectors belong to the member who created them.
- Budgets: `weekly` = ISO Mon–Sun, `monthly` = calendar month, in the household timezone (default `Europe/Berlin`); no rollover; base currency EUR by default.
- Each account has `countsTowardBudgets` (default true for `household`, false for `owner-only`); budgets are computed once per household.
- PSD2 connectors: max 4 unattended fetches per account per 24 h, default times 06:00/12:00/18:00/23:00; user-present fetches don't count. FinTS: every 4 h default.
- The server never starts an interactive bank dialog on its own; it sets `needs_attention` and waits for the user.
- Repo layout: `src/`, `tests/`, `ci/` (scripts; GitHub requires workflows in `.github/workflows`), `docs/`.
- Every behavioural change updates the relevant `docs/specs/<area>.md` in the same commit/PR.
- No AI attribution in commits, PRs or docs.

## Review Focus

1. **Pending → booked with a changed amount** (restaurant tip, hotel pre-auth): must remain one transaction, updated, never double-counted in a budget. → test in Task 9.
2. **Refunds** in a budget category (positive amount on Groceries): reduce that budget's spent amount; never counted as income in the breakdown. → test in Task 12.
3. **Period boundaries in local time**: a card payment at Sunday 23:30 Berlin time (UTC Sunday 21:30/22:30) belongs to that Berlin week; DST switch weeks have correct bounds. → tests in Task 2.
4. **Visibility toggled to `owner-only` mid-period**: from that moment no endpoint, aggregate breakdown drilldown or pending notification text reveals that account's transactions to other members. → test in Task 7 and Task 12.
5. **Abandoned challenge** (user opens reconnect, never confirms): challenge expires, connector stays `needs_attention`, a new reconnect works, no stuck lock or zombie job. → test in Task 10.

---

### Task 1: Monorepo, tooling, CI and spec-driven documentation

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.js`, `.prettierrc`, `.editorconfig`, `.gitignore`, `.nvmrc`, `vitest.workspace.ts`, `GitVersion.yml`
- Create: `src/shared/package.json`, `src/shared/tsconfig.json`, `src/shared/src/index.ts`
- Create: `src/server/package.json`, `src/server/tsconfig.json`, `src/server/src/index.ts`
- Create: `.github/workflows/ci.yml`, `ci/check.sh`
- Create: `AGENTS.md`, `CLAUDE.md`, `README.md`, `LICENSE` (AGPL-3.0, full official text; `"license": "AGPL-3.0-only"` in every package.json — owner decision 2026-11-09; record in `docs/adr/0008-agpl-license.md`)
- Create: `docs/specs/household-and-access.md`, `docs/specs/sync-and-connectors.md`, `docs/specs/categorization.md`, `docs/specs/budgets.md`, `docs/specs/net-worth.md`, `docs/specs/security.md`, `docs/specs/self-hosting.md`, `docs/specs/README.md`
- Create: `docs/adr/0001-typescript-throughout.md`, `0002-enable-banking-byo-key.md`, `0003-unofficial-broker-connectors.md`, `0004-envelope-encryption.md`, `0005-server-fetch-app-challenges.md`, `0006-no-push-service-v1.md`, `0007-shared-nme-pgsql.md`
- Create: `docs/architecture.md` (Mermaid diagram: app ↔ API ↔ Postgres; jobs; connectors; master key source)
- Test: `tests/smoke.test.ts`

**Interfaces:**
- Produces: workspace packages `@budgedino/shared`, `@budgedino/server`; root scripts `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration`.

- [ ] **Step 1:** Write `tests/smoke.test.ts` asserting `import { VERSION } from '@budgedino/shared'` is a non-empty string.
- [ ] **Step 2:** Run `pnpm test` → FAIL (package missing).
- [ ] **Step 3:** Create workspace, tsconfig (strict, `noUncheckedIndexedAccess`, ESM, `moduleResolution: bundler`), ESLint flat config (typescript-eslint strict), Vitest workspace (unit project; `integration` project matching `**/*.int.test.ts`), export `VERSION` from shared.
- [ ] **Step 4:** Run `pnpm lint && pnpm typecheck && pnpm test` → PASS.
- [ ] **Step 5:** Write docs. Per-area specs: move the matching sections of the founding design into each area file (keep **[owner]**/**[call]** markers), and replace the founding design's body sections with links ("superseded by area specs"). ADRs: Context / Decision / Consequences, one page each, from the founding design. `AGENTS.md`: workflow rule "spec → failing test → code → spec updated in same PR", repo map, commands, the Global Constraints above, "never run an Android emulator without owner approval", "no AI attribution". `CLAUDE.md` contains only `@AGENTS.md`.
- [ ] **Step 6:** `ci.yml`: on PR and push to `main`: setup pnpm + Node from `.nvmrc`, `pnpm install --frozen-lockfile`, `ci/check.sh` (lint, typecheck, unit, integration — Docker available on `ubuntu-latest`). `GitVersion.yml`: `mode: Mainline`.
- [ ] **Step 7:** Commit `chore: scaffold monorepo, CI and spec-driven docs`.

### Task 2: Money and budget periods (`@budgedino/shared`)

**Files:**
- Create: `src/shared/src/money.ts`, `src/shared/src/period.ts`
- Test: `tests/shared/money.test.ts`, `tests/shared/period.test.ts`

**Interfaces:**
- Produces:
  - `type CurrencyCode = string` (validated ISO 4217, 3 uppercase letters)
  - `interface Money { minor: bigint; currency: CurrencyCode }`
  - `money(minor: bigint | number, currency: CurrencyCode): Money` (throws on non-integer number)
  - `add(a: Money, b: Money): Money`, `sum(items: Money[], currency: CurrencyCode): Money`, `negate(m: Money): Money`, `isNegative(m: Money): boolean`
  - `class CurrencyMismatchError extends Error`
  - `toJSON(m: Money): { minor: string; currency: string }`, `fromJSON(...)` (bigint as string over the wire)
  - `type PeriodKind = 'weekly' | 'monthly'`
  - `interface Period { kind: PeriodKind; start: Date; end: Date /* exclusive */; key: string /* '2026-W46' | '2026-11' */ }`
  - `periodFor(instant: Date, kind: PeriodKind, timeZone: string): Period`
  - `previousPeriod(p: Period, timeZone: string): Period`
- Use `Temporal` polyfill (`temporal-polyfill`) or `@js-temporal/polyfill` for zone math — not `Date` arithmetic.

- [ ] **Step 1:** Tests:
  - `add(money(150,'EUR'), money(-50,'EUR'))` equals `money(100,'EUR')`; `add` EUR+USD throws `CurrencyMismatchError`; `money(1.5,'EUR')` throws.
  - fast-check: `sum` is associative/commutative; `toJSON`→`fromJSON` round-trips for arbitrary bigint.
  - `periodFor(2026-11-15T22:30:00Z, 'weekly', 'Europe/Berlin')` → key `2026-W46`, start `2026-11-09T00:00+01:00`, end `2026-11-16T00:00+01:00` (Sunday 23:30 Berlin stays in W46).
  - `periodFor(2026-11-15T23:30:00Z, 'weekly', 'Europe/Berlin')` → `2026-W47`.
  - DST week: `periodFor(2026-03-29T12:00:00Z, 'weekly', 'Europe/Berlin')` → end − start = 167 h.
  - `periodFor(2026-12-31T23:30:00Z, 'monthly', 'Europe/Berlin')` → key `2027-01`.
  - ISO year edge: `periodFor(2026-12-31T12:00:00Z,'weekly','Europe/Berlin')` key `2026-W53`.
  - fast-check: for any instant, `start <= instant < end`, and `previousPeriod(p).end == p.start`.
- [ ] **Step 2:** Run `pnpm test tests/shared` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(shared): money and budget periods`.

### Task 3: Envelope encryption (`src/server/src/crypto`)

**Files:**
- Create: `src/server/src/crypto/master-key.ts`, `src/server/src/crypto/envelope.ts`, `src/server/src/crypto/index.ts`
- Test: `tests/server/crypto/envelope.test.ts`

**Interfaces:**
- Produces:
  - `loadMasterKey(env: NodeJS.ProcessEnv): MasterKey` — reads `BUDGEDINO_MASTER_KEY` (base64, 32 bytes) or `BUDGEDINO_MASTER_KEY_FILE`; throws `MasterKeyError` with a message that never includes key material.
  - `interface MasterKey { id: string /* first 8 hex of SHA-256 */; }` (key bytes in a private field)
  - `generateDataKey(): DataKey`; `wrapDataKey(master: MasterKey, dk: DataKey): Buffer`; `unwrapDataKey(master: MasterKey, wrapped: Buffer): DataKey`
  - `encryptField(dk: DataKey, plaintext: string | Buffer, aad: FieldAad): Buffer`; `decryptField(dk: DataKey, blob: Buffer, aad: FieldAad): Buffer`; `decryptString(...)`
  - `interface FieldAad { table: string; column: string; rowId: string }`
  - `blindIndex(dk: DataKey, purpose: string, value: string): string` (HMAC-SHA256 hex; separate subkey derived via HKDF per purpose) — used for dedup keys and exact-match lookups.
- Algorithm: AES-256-GCM, 12-byte random IV; blob = `0x01 (version) | iv | tag | ciphertext`; AAD = `table|column|rowId`. Data key derives two subkeys with HKDF-SHA256 (`enc`, `idx:<purpose>`).

- [ ] **Step 1:** Tests: round-trip; tampered ciphertext byte → throws; decrypt with AAD of another row → throws; wrong data key → throws; `wrap`/`unwrap` round-trip; unwrap with different master → throws; two encryptions of same plaintext differ; `blindIndex` deterministic per key and differs across keys and purposes; `loadMasterKey` with 31-byte key throws and the error message does not contain the env value.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement with `node:crypto`. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(server): envelope encryption`.

### Task 4: Database, migrations, encrypted repositories, test harness

**Files:**
- Create: `src/server/src/db/schema.ts`, `src/server/src/db/client.ts`, `src/server/src/db/migrate.ts`, `src/server/drizzle.config.ts`, `src/server/drizzle/` (generated)
- Create: `src/server/src/households/keyring.ts`
- Create: `tests/support/postgres.ts` (Testcontainers global setup, per-test schema reset), `tests/support/factories.ts`
- Test: `tests/server/db/at-rest.int.test.ts`, `tests/server/households/keyring.int.test.ts`

**Interfaces:**
- Consumes: Task 3 crypto.
- Produces tables (UUID v7 ids; `bytea` for encrypted columns, suffixed `_enc`; blind indexes suffixed `_bidx`):
  - `households(id, name, timezone, base_currency, created_at)`
  - `household_keys(household_id, version, wrapped_key bytea, master_key_id, active, created_at)`
  - `members(id, household_id, role 'admin'|'member', email_bidx, email_enc, display_name_enc, password_hash, totp_secret_enc, created_at, disabled_at)`
  - `invites(id, household_id, token_hash, role, expires_at, used_at)`
  - `sessions(id, member_id, device_name_enc, token_hash, created_at, last_seen_at, revoked_at)`
  - `connectors(id, household_id, owner_member_id, type, status 'ok'|'needs_attention'|'error'|'disabled', config_enc, state_enc, last_success_at, last_error_code, consent_expires_at, created_at)`
  - `accounts(id, connector_id, owner_member_id, external_ref_bidx, name_enc, iban_enc, kind 'checking'|'savings'|'credit_card'|'depot'|'other', currency, visibility 'household'|'owner_only', counts_toward_budgets bool, balance_enc, balance_at)`
  - `transactions(id, account_id, dedup_bidx unique per account, status 'pending'|'booked', booking_date date, value_date date, amount_enc, currency, counterparty_enc, counterparty_bidx, purpose_enc, mcc, category_id, category_source 'rule'|'learned'|'heuristic'|'manual'|'none', transfer_group_id, created_at, updated_at)`
  - `transaction_splits(id, transaction_id, category_id, amount_enc)`
  - `categories(id, household_id, name, group, is_income, is_transfer, archived)`
  - `rules(id, household_id, priority, match_enc /* JSON */, category_id, created_by, created_at)`
  - `budgets(id, household_id, name, category_ids uuid[], period_kind, amount_minor_enc, currency, archived)`
  - `sync_runs(id, connector_id, trigger 'schedule'|'user', user_present bool, started_at, finished_at, outcome, error_code)`
  - `challenges(id, connector_id, member_id, kind 'redirect'|'decoupled'|'code'|'image', payload_enc, status 'open'|'answered'|'completed'|'expired'|'cancelled', expires_at, created_at)`
  - `notifications(id, household_id, member_id, kind, body_enc, created_at, delivered_at)`
  - `fx_rates(date, currency, rate_per_eur numeric)`
  - `Keyring.forHousehold(householdId): Promise<DataKey>` (cached; unwraps active key), `Keyring.rotateMaster(oldMaster, newMaster)` (rewraps all household keys).
- Plaintext by design: dates, currency codes, enums, foreign keys, `mcc`, timezone, category names (decided: category names are not sensitive — **[call]**, note in `security.md`).

- [ ] **Step 1:** `at-rest.int.test.ts`: insert a member, account and transaction through the repositories with canary strings (`CANARY-IBAN-DE00`, `CANARY-PAYEE`, amount `987654`); `pg_dump --data-only` of the test DB (via container exec) must not contain any canary. `keyring.int.test.ts`: rotate master key → all data still decrypts with new master, old master fails to unwrap.
- [ ] **Step 2:** Run `pnpm test:integration` → FAIL.
- [ ] **Step 3:** Implement schema, migration runner (`migrate()` on server start, behind advisory lock), keyring, minimal repositories used by the tests.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(server): schema, keyring, at-rest encryption`.

### Task 5: Logging, telemetry and redaction

**Files:**
- Create: `src/server/src/observability/logger.ts`, `src/server/src/observability/otel.ts`, `src/server/src/observability/redact.ts`
- Test: `tests/server/observability/redact.test.ts`

**Interfaces:**
- Produces: `createLogger(): Logger` (pino, JSON, includes `trace_id`/`span_id` from active span); `redact(value: unknown): unknown` (deep; drops keys matching `/amount|iban|counterparty|purpose|payee|password|pin|tan|token|secret|key|balance|email/i`, and any string matching an IBAN regex); `startTelemetry(env)` — no-op unless `OTEL_EXPORTER_OTLP_ENDPOINT` set.

- [ ] **Step 1:** Tests: logger output for `{ amount: 5, nested: { iban: 'DE89370400440532013000' }, note: 'paid DE89370400440532013000' }` contains neither `5`-valued amount field nor the IBAN; log lines include `trace_id` inside an active span; Fastify request logs omit bodies and `authorization` header.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(server): redacting logger and OpenTelemetry`.

### Task 6: Household bootstrap, invites, authentication, sessions

**Files:**
- Create: `src/server/src/app.ts` (`buildApp(deps): FastifyInstance`), `src/server/src/cli.ts` (`budgedino` bin)
- Create: `src/server/src/auth/{passwords.ts,totp.ts,sessions.ts,routes.ts,guard.ts,rate-limit.ts}`
- Create: `src/server/src/households/{bootstrap.ts,invites.ts,routes.ts}`
- Create: `src/server/src/categorization/defaults.ts` (`DEFAULT_CATEGORIES`, list in Task 11; bootstrap seeds it)
- Test: `tests/server/auth/auth.int.test.ts`, `tests/server/cli.int.test.ts`

**Interfaces:**
- Produces:
  - CLI: `budgedino init-key` (prints a new master key once, asks the operator to type its last 6 chars to confirm a saved copy), `budgedino bootstrap --household <name> --timezone Europe/Berlin` (creates household + data key + seeds default categories from Task 11's list + prints one-time admin invite token), `budgedino invite --household <id> --role member`, `budgedino rotate-master-key`.
  - HTTP (all under `/api/v1`, zod schemas in `@budgedino/shared/api`):
    - `POST /auth/register` `{ inviteToken, email, password, displayName, deviceName }` → `{ totpProvisioningUri, pendingId }`
    - `POST /auth/register/confirm` `{ pendingId, totpCode }` → `{ sessionToken }`
    - `POST /auth/login` `{ email, password, totpCode, deviceName }` → `{ sessionToken }`
    - `GET /auth/sessions`, `DELETE /auth/sessions/:id`
    - `POST /households/invites` (admin) → `{ inviteToken, expiresAt }`
  - `requireMember(req): Promise<AuthContext>`; `interface AuthContext { memberId; householdId; role; sessionId }`
- Passwords: argon2id (`@node-rs/argon2`, OWASP params); min length 12. Session token: 32 random bytes, base64url; only SHA-256 stored. Invite token: same scheme, 7-day expiry, single use. Rate limit: 5 failed logins per email per 15 min and 20 per IP → 429; constant-time failure responses (no user enumeration). Passkeys: later plan (extension point noted in `household-and-access.md`).

- [ ] **Step 1:** Tests: full register→confirm→login flow; login without TOTP → 401; wrong TOTP → 401 with same body as unknown email; reused invite → 410; expired invite → 410; 6th failed login → 429; revoked session → 401 on next request; member cannot create invites (403); CLI `bootstrap` creates household, keys and categories, prints invite usable by `/auth/register`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(server): bootstrap, invites, password+TOTP auth, sessions`.

### Task 7: Visibility enforcement and accounts API

**Files:**
- Create: `src/server/src/access/visibility.ts`, `src/server/src/accounts/{repository.ts,routes.ts}`
- Test: `tests/server/access/visibility.int.test.ts`

**Interfaces:**
- Produces:
  - `visibleAccountIds(ctx: AuthContext): Promise<string[]>` — accounts where `visibility='household'` in the household, or `owner_member_id = ctx.memberId`. All reads of accounts, transactions, splits, balances and per-account notifications go through this.
  - `GET /accounts`, `PATCH /accounts/:id` `{ visibility?, countsTowardBudgets? }` (owner only; changing visibility to `owner_only` sets `countsTowardBudgets=false` unless explicitly passed).
- Every route registers `config: { access: 'public' | 'member' | 'admin' }`; app start fails if a route lacks it.

- [ ] **Step 1:** Tests: two members A (admin) and B; B owns an `owner_only` account with transactions. For **every registered GET route** (enumerated from `app.printRoutes`/route hooks, with ids substituted from fixtures), A's responses must not contain B's account id, transaction ids or decrypted canary payee. Toggle B's account from `household` to `owner_only` → immediately invisible to A on all routes (Review Focus 4). A cannot `PATCH` B's account (404, not 403). A route without `config.access` → `buildApp` throws.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(server): server-side visibility enforcement`.

### Task 8: Connector interface, challenge model, fake connector

**Files:**
- Create: `src/server/src/connectors/types.ts`, `src/server/src/connectors/registry.ts`, `src/server/src/connectors/fake/fake-connector.ts`
- Create: `src/shared/src/api/challenges.ts` (zod schemas shared with the app)
- Test: `tests/server/connectors/fake-connector.test.ts`, `tests/server/connectors/contract.ts` (reusable contract suite)

**Interfaces:**
- Produces:
  ```ts
  type ChallengeKind = 'redirect' | 'decoupled' | 'code' | 'image';
  type Challenge =
    | { kind: 'redirect'; url: string; returnUrlScheme: string }
    | { kind: 'decoupled'; message: string; pollAfterMs: number }
    | { kind: 'code'; message: string; length?: number }
    | { kind: 'image'; message: string; imagePngBase64: string };
  type ChallengeAnswer =
    | { kind: 'redirect'; callbackUrl: string }
    | { kind: 'decoupled' }            // "I confirmed", server polls
    | { kind: 'code' | 'image'; code: string };

  interface RateLimitPolicy { maxUnattendedPerDay: number | null; defaultSchedule: { cron: string } | { times: string[] } }

  interface ConnectorContext { now(): Date; userPresent: boolean; psuIp?: string; logger: Logger }

  type AuthStep =
    | { done: true; state: ConnectorState; consentExpiresAt?: Date }
    | { done: false; challenge: Challenge; dialog: DialogState };

  interface Connector {
    type: string;                         // 'fake', 'fints', 'enablebanking', ...
    experimental: boolean;
    challengeKinds: ChallengeKind[];
    rateLimit: RateLimitPolicy;
    startAuth(config: ConnectorConfig, ctx: ConnectorContext): Promise<AuthStep>;
    continueAuth(dialog: DialogState, answer: ChallengeAnswer, ctx: ConnectorContext): Promise<AuthStep>;
    listAccounts(state: ConnectorState, ctx: ConnectorContext): Promise<ProviderAccount[]>;
    fetchTransactions(state: ConnectorState, accountRef: string, since: Date | null, ctx: ConnectorContext): Promise<FetchResult>;
  }
  type FetchResult = { ok: true; transactions: ProviderTransaction[]; balance?: Money; state: ConnectorState }
                   | { ok: false; reason: 'needs_attention' | 'rate_limited' | 'temporary' ; retryAfter?: Date };
  interface ProviderTransaction { providerId: string | null; status: 'pending'|'booked'; bookingDate: string; valueDate?: string; amount: Money; counterparty?: string; counterpartyIban?: string; purpose?: string; mcc?: string }
  interface ProviderAccount { ref: string; name: string; iban?: string; kind: AccountKind; currency: CurrencyCode }
  ```
  `ConnectorConfig`, `ConnectorState`, `DialogState` are opaque JSON stored encrypted. `registry.get(type): Connector`.
- `FakeConnector`: scripted via its config (`{ scenario: 'happy' | 'decoupled' | 'code' | 'redirect' | 'expired-consent' | 'flaky', transactions: [...] }`), deterministic, used by all later tests.
- `contract.ts`: `runConnectorContract(make: () => Connector, script)` asserting: auth eventually `done`; `fetchTransactions` idempotent for same `since`; returns only known statuses; never throws for bank-side errors (returns `ok:false`).

- [ ] **Step 1–4:** Write contract suite + fake connector tests (each scenario) → FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(server): connector interface, challenges, fake connector`.

### Task 9: Sync engine and scheduler

**Files:**
- Create: `src/server/src/sync/{jobs.ts,scheduler.ts,ingest.ts,rate-guard.ts,routes.ts}`
- Test: `tests/server/sync/ingest.int.test.ts`, `tests/server/sync/scheduler.test.ts`, `tests/server/sync/rate-guard.int.test.ts`

**Interfaces:**
- Consumes: Task 8 `Connector`, Task 4 schema, Task 3 `blindIndex`, Task 11 `categorize` (call through an injected `onIngested(txIds)` hook so this task doesn't depend on Task 11).
- Produces:
  - `ingest(accountId, txs: ProviderTransaction[]): Promise<{ inserted: string[]; updated: string[] }>` — dedup key = `blindIndex(dk,'tx', providerId ?? contentHash)`, where `contentHash = sha256(bookingDate|amount|currency|counterpartyIban|purpose)`. Pending→booked reconciliation: a booked tx without matching dedup key matches an existing pending tx on same account with same counterparty blind index, |Δamount| ≤ 25% and booking within 7 days of the pending date; it updates that row (keeps id, category).
  - `runSync(connectorId, trigger: 'schedule'|'user', ctx)`: honors `rate-guard` (counts unattended `sync_runs` in rolling 24 h per connector against `maxUnattendedPerDay`; user-present runs are not counted and pass `userPresent: true` + `psuIp`); `ok:false needs_attention` → set connector `needs_attention`, create notification for the connector owner (`kind: 'connector_attention'`, body without amounts).
  - `nextRuns(policy: RateLimitPolicy, timeZone: string, from: Date): Date[]` for the scheduler; pg-boss jobs `sync.connector` (singleton per connector) and `sync.tick` (every 5 min, enqueues due connectors).
  - `POST /connectors/:id/sync` (owner only) → 202 `{ runId }`; `GET /connectors` (own + statuses).
- [ ] **Step 1:** Tests: same batch ingested twice → no duplicates; tx without `providerId` deduped by content hash; **pending €42.00 then booked €48.50 same payee within 2 days → one row, status booked, amount 48.50, category kept** (Review Focus 1); two genuine identical €3.20 bakery payments on the same day with distinct provider ids → two rows; rate guard: 5th unattended run in 24 h is skipped with `outcome='rate_limited'`, user run still executes; `nextRuns({times:['06:00','12:00','18:00','23:00']}, 'Europe/Berlin', 2026-11-09T10:00Z)` first = `2026-11-09T11:00Z`; `needs_attention` result → connector status + one notification for owner only.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(server): sync engine, rate guard, scheduler`.

### Task 10: Connector connect/reconnect and challenge API

**Files:**
- Create: `src/server/src/connectors/{routes.ts,challenge-service.ts}`
- Test: `tests/server/connectors/challenge.int.test.ts`

**Interfaces:**
- Produces:
  - `POST /connectors` `{ type, config }` → `{ connectorId, challenge?: ChallengeView }` (creates in `needs_attention` until auth done)
  - `POST /connectors/:id/reconnect` → `{ challenge?: ChallengeView }` (only the owner; only user-initiated — no server-side caller exists)
  - `POST /challenges/:id/answer` `ChallengeAnswer` → `{ status, challenge?: ChallengeView }` (multi-step allowed)
  - `GET /challenges/:id` → `{ status }` (app polls during `decoupled`)
  - `DELETE /challenges/:id` → cancel
  - `ChallengeView = { id; expiresAt } & Challenge`
  - Challenge TTL 10 min; expiry sweeper job `challenges.expire` every minute. At most one open challenge per connector; a new reconnect cancels the previous one. On `done` → store state, set `ok`, `consent_expires_at`, run accounts discovery and a user-present sync.
- [ ] **Step 1:** Tests with FakeConnector: `decoupled` flow completes after answer; `code` flow with wrong then right code; `redirect` flow with callback URL; **abandoned challenge → after TTL status `expired`, connector `needs_attention`, new reconnect returns a fresh challenge and completes** (Review Focus 5); member B cannot answer A's challenge (404); `DialogState` never appears in any response.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(server): connect/reconnect with typed challenges`.

### Task 11: Categorization and transfer detection

**Files:**
- Create: `src/server/src/categorization/{engine.ts,rules.ts,transfers.ts,routes.ts}` (`defaults.ts` exists from Task 6)
- Test: `tests/server/categorization/engine.test.ts`, `tests/server/categorization/transfers.int.test.ts`, `tests/server/categorization/routes.int.test.ts`

**Interfaces:**
- Produces:
  - `DEFAULT_CATEGORIES`: Groceries, Eating out, Transport, Housing, Utilities, Insurance, Subscriptions, Shopping, Health, Kids, Leisure, Travel, Gifts & Donations, Fees, Cash, Savings & Investments, Income (is_income), Transfer (is_transfer), Uncategorized.
  - `interface RuleMatch { counterpartyContains?: string; counterpartyIban?: string; purposeContains?: string; amountMinMinor?: string; amountMaxMinor?: string; accountId?: string }` (case-insensitive, all present fields must match)
  - `categorize(tx: DecryptedTx, ctx: { rules: Rule[]; learned: Map<string /*counterparty_bidx*/, string /*categoryId*/>; heuristics: Heuristics }): { categoryId: string | null; source: CategorySource }` — precedence: rules (by priority, then newest) → learned → heuristics (MCC table, merchant keyword list) → none. Manual categories are never overwritten.
  - `detectTransfers(householdId, txIds): Promise<void>` — pairs opposite amounts (same currency, same absolute minor) across two different household accounts within ±4 days, prefer counterparty IBAN = other account's IBAN; assigns a shared `transfer_group_id` and the `Transfer` category; considers all household accounts including `owner_only` (so a transfer to a hidden account is still excluded from budgets) without exposing the pair to other members.
  - `PATCH /transactions/:id` `{ categoryId, applyToCounterparty?: boolean }` → manual; when `applyToCounterparty` creates a rule `{ counterpartyIban ?? counterpartyContains }` and recategorizes past non-manual tx of that counterparty.
  - `POST /transactions/:id/splits` `{ parts: { categoryId, amount }[] }` (sum must equal tx amount → else 422).
- [ ] **Step 1:** Tests: precedence rule > learned > heuristic; manual never overwritten by re-run; MCC 5411 → Groceries; "REWE" keyword → Groceries; transfer pair across two members' accounts detected, single unmatched outgoing transfer not; split sum mismatch → 422; `applyToCounterparty` recategorizes history and future ingests; fast-check: categorize is deterministic for a fixed context.
- [ ] **Step 2–4:** FAIL → implement → PASS. Wire `onIngested` from Task 9 to `categorize` + `detectTransfers`.
- [ ] **Step 5:** Commit `feat(server): categorization, rules, transfer detection`.

### Task 12: Budgets, FX, home summary, notifications polling

**Files:**
- Create: `src/server/src/budgets/{service.ts,routes.ts,alerts.ts}`, `src/server/src/fx/{ecb.ts,service.ts}`, `src/server/src/home/routes.ts`, `src/server/src/notifications/routes.ts`
- Test: `tests/server/budgets/service.int.test.ts`, `tests/server/fx/ecb.test.ts` (fixture XML), `tests/server/home/home.int.test.ts`

**Interfaces:**
- Consumes: Task 2 `periodFor`, Task 7 `visibleAccountIds`, Task 11 categories.
- Produces:
  - `spentFor(budget, period): Promise<Money>` — sum over booked + pending transactions (and splits) in `budget.category_ids`, accounts with `counts_toward_budgets=true` (all such household accounts, regardless of viewer), excluding `transfer_group_id` not null; spending is the negated sum, so refunds reduce it (may go below zero → clamp display at 0, keep raw value). Foreign currency converted to household base currency via `fx.convert(money, bookingDate)` (ECB rate of that date or the latest earlier).
  - `fx`: daily job `fx.refresh` fetching `https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml`; `convert(m: Money, on: string, to: CurrencyCode): Promise<Money>` (banker's rounding to minor units).
  - `GET /budgets`, `POST /budgets` `{ name, categoryIds, periodKind, amount }` (admin), `PATCH`, `DELETE` (archive).
  - `GET /home?period=current` → `{ period: { key, start, end }, budgets: { id, name, amount, spent, ratio }[], breakdown: { categoryId, name, spent }[] /* only viewer-visible transactions */, sync: { connectorId, type, status, lastSuccessAt }[] /* viewer's own connectors + household-visible statuses */ }`
  - `alerts.evaluate(householdId)` after each ingest: crossing 80% / 100% of a budget creates one notification per member per budget per threshold per period (`kind: 'budget_threshold'`, body `"<budget name> reached 80%"` — no amounts).
  - `GET /notifications?since=<cursor>` → own pending notifications; `POST /notifications/ack`.
- [ ] **Step 1:** Tests: budget Groceries €500 monthly; spends €200 + €140 → `spent 340, ratio 0.68`; **refund +€20 → spent 320, breakdown shows Groceries 320, Income unchanged** (Review Focus 2); transfer pair not counted; account with `countsTowardBudgets=false` not counted; owner-only account with `countsTowardBudgets=true` counts in budget totals for both members, but its transactions are absent from member A's breakdown drilldown and notification bodies (Review Focus 4); USD $10.00 on a date with rate 1.0800 → €9.26; crossing 80% creates exactly one notification per member, second ingest doesn't duplicate; ECB fixture parses 90 days.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(server): budgets, FX, home summary, notification polling`.

### Task 13: End-to-end API scenario and docs sync

**Files:**
- Create: `tests/e2e/household-slice.e2e.test.ts`, `src/server/src/main.ts` (production entry: telemetry → migrate → app → pg-boss)
- Modify: `docs/specs/*.md` (any deviation found during implementation), `README.md` (dev setup), `docs/architecture.md`
- Modify: `.github/workflows/ci.yml` (add e2e project)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1:** Write the e2e test, running `main.ts` against a Testcontainers Postgres with only `FakeConnector` registered: CLI `init-key` + `bootstrap` → admin registers (TOTP via `otplib`) → invites Jess → Jess registers → admin creates Groceries €500 monthly budget → admin connects FakeConnector `decoupled` scenario (answer challenge) → Jess connects her own FakeConnector `code` scenario and marks it `owner_only` → `sync` → `GET /home` for admin shows Groceries `spent 340` and a breakdown without Jess's hidden transactions; admin `GET /notifications` contains a `budget_threshold` once ratio ≥ 0.8; raw DB dump contains no canary strings.
- [ ] **Step 2:** Run `pnpm test:e2e` → PASS (fix forward through the owning task's module if it fails).
- [ ] **Step 3:** Update specs/README/architecture to match what was built; check the generated OpenAPI (`GET /api/v1/openapi.json`) is committed to `docs/api/openapi.json` and CI fails if it drifts.
- [ ] **Step 4:** Run `ci/check.sh` → all green.
- [ ] **Step 5:** Commit `test: end-to-end household slice; sync docs`.

---

## Follow-up plans (not in P1)

- **P2 FinTS connector:** DKB (decoupled TAN), Comdirect; fake FinTS server; opt-in live tests; depot holdings.
- **P3 Android app slice:** Expo dev build, server URL + login + TOTP, home screen, transactions/recategorize, challenge screens (deep-link redirect, decoupled wait, code/image), Keystore-encrypted cache, app lock, background notification polling; Maestro on physical device / device farm.
- **P4 Enable Banking** (C24, Revolut) incl. CLI registration wizard.
- **P5 Net worth** (daily snapshots, history by source, manual assets).
- **P6 Self-hosting packaging** (image, compose, backup/restore docs) + separate NME-IaC PR for Horus.
- **P7 Experimental brokers** (Trade Republic, Scalable — research ADR first).
- Later: passkeys, instant push relay (opt-in), iOS.

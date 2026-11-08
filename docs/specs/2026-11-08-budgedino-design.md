# BudgeDino — Founding Design

- Status: Approved by owner (2026-11-09)
- Date: 2026-11-08
- Origin: brainstorming session between the owner and Claude

This document is the founding design. After approval it is split into living per-area specs under
`docs/specs/` (see §15) and decision records under `docs/adr/`. Items marked **[owner]** were decided
by the owner; items marked **[call]** are the AI's call and may be challenged.

## 1. Intent and why

The owner and their wife Jess keep asking themselves *where all our money goes*. Earlier attempts at an
overview (spreadsheets, apps) failed because they needed manual steps that stopped being done.

BudgeDino is an open-source, self-hostable household finance app that answers that question
**without recurring manual work**: it pulls accounts, transactions and depot holdings from the banks
and brokers automatically, categorizes transactions, and shows them against household budgets.

**Success:** the owner and Jess open the app and immediately see how far each budget is used this
week/month and where the money went, and that view is correct and current without them having done
anything since the last time.

## 2. Goals, non-goals, anti-goals

### Goals (v1)
- Automatic scheduled and on-demand sync of accounts, transactions and holdings for DKB, C24,
  Revolut, Comdirect, Trade Republic, Scalable Capital. **[owner]**
- Automatic categorization that learns from corrections.
- Household with invited members; budgets per category per week or month. **[owner]**
- Home screen: budget progress and spending breakdown. **[owner]**
- Separate net-worth view: historical graph split by source, plus list of all sources. **[owner]**
- Per-account visibility toggles from the start; default fully transparent. **[owner]**
- Strong encryption; self-hostable; open source; no licensing costs. **[owner]**
- Android app from the start. **[owner]**
- Strong unit and end-to-end testing. **[owner]**
- Spec-driven development with persistent documented context. **[owner]**

### Non-goals (v1)
- iOS app (later; the stack must not prevent it). **[owner]**
- Initiating payments/transfers. Read-only access to banks. **[call]**
- Web UI for end users. **[call]** (the stack must allow adding one later)
- Sending financial data to external AI/LLM services. **[call]**
- Multi-household tenancy per server beyond what falls out naturally (one server may host several
  households, but no SaaS features like billing). **[call]**
- Tax reporting, investment performance analytics (IRR etc.).

### Anti-goals (failure even if it technically works)
- Any **routine** manual step (CSV imports, typing transactions, recategorizing most transactions).
  The only accepted manual steps are bank-mandated consent renewals and occasional corrections.
- Sensitive data readable from a stolen database dump, backup, disk, logs or telemetry.
- Licensing costs or a mandatory paid third party for self-hosters.
- Silent staleness: data that is out of date without the app saying so.

## 3. Household and access model

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

## 4. Screens (Android)

1. **Home**: budget progress per category for the current period (e.g. "Groceries €340 / €500,
   this month"), and a breakdown of where money went (by category, drillable into transactions).
   **[owner]** Shows sync freshness and any connector needing attention. **[call]**
2. **Transactions**: list, search, filter; recategorize; split a transaction across categories. **[call]**
3. **Budgets**: create/edit per category, period weekly or monthly. **[owner]**
4. **Net worth** (not on home): history graph stacked by source, list of sources (bank accounts, depots,
   etc.) with current value. **[owner]**
5. **Connections**: add/repair connectors, consent-expiry status, "sync now". **[call]**
6. **Household & settings**: members, invites, account visibility, categories, rules, app lock. **[call]**

## 5. Data sources and connectors

Pluggable connector architecture: each connector implements a common interface (list accounts,
fetch transactions since cursor, fetch balances, fetch holdings, auth/consent lifecycle, health).
Replacing a connector must not affect the rest of the system. **[owner]**

| Institution | Data | Route | Status |
|---|---|---|---|
| DKB | accounts, transactions, depot | FinTS 3.0 PIN/TAN (decoupled TAN) | official |
| Comdirect | accounts, transactions, depot | FinTS 3.0 PIN/TAN | official |
| C24 | accounts, transactions | Enable Banking (PSD2 AIS) | official via aggregator |
| Revolut | accounts, transactions (incl. multi-currency) | Enable Banking | official via aggregator |
| Trade Republic | cash, transactions, holdings | unofficial reverse-engineered API (port of pytr protocol to TS) | **experimental** |
| Scalable Capital | holdings, transactions | unofficial (approach to be researched) | **experimental** |

Further institutions come from the same connectors (any FinTS bank; any Enable Banking bank).

- **FinTS** via `lib-fints` (TypeScript, LGPL-2.1, tested with DKB and comdirect). **[call]**
- **Enable Banking** in free "restricted/personal" mode: each self-hoster registers their own Enable
  Banking application. The app provides a guided wizard (server generates the key pair, shows what to
  paste where, verifies the result). Accepted by owner as a necessary evil. **[owner]**
- GoCardless Bank Account Data is closed to new signups (July 2025) — not used.
- **Unofficial connectors** are allowed. **[owner]** They are **best effort and not part of the v1
  definition of done**; they are built after the core works, and a phone-confirmed re-login (one tap)
  is accepted as an exception to the no-manual-steps rule for them. **[owner]** They are labelled experimental in the UI. When one
  fails, its source keeps its last known holdings/value (marked stale) instead of dropping to zero. **[call]**
- Revolut stocks and other non-payment assets are not reachable via PSD2; out of v1 unless a route
  appears. Manual asset entries (e.g. property, cash) are allowed as an explicit, optional feature. **[call]**

## 6. Sync

### Where bank interaction runs **[owner]**
- **Data fetching runs on the server**: unattended, scheduled, within the consent's validity.
- **Every interactive step runs in the app, started by the user.** When a bank needs the user (expired
  consent, TAN, re-login), the server does *not* start a dialog on its own. It marks the connector
  `needs_attention` and notifies the connector's owner. The user taps the notification or "reconnect";
  only then does the server open the bank dialog and hand the app a **typed challenge**:
  - `redirect` — the app opens the bank URL in a browser tab; the bank redirects back into the app via
    a deep link; the app posts the result to the server.
  - `decoupled` — "confirm in your bank app" (e.g. DKB); the app shows a waiting state, the server polls
    the bank.
  - `code` — TAN or SMS code entry.
  - `image` — photoTAN/chipTAN image plus code entry.
- The server keeps the bank dialog state for the duration of the challenge (minutes) and continues the
  same dialog with the user's answer, so the bank session and the user are in the same moment.
- Each connector declares which challenge types it can raise; new bank quirks become new challenge
  types, not a new architecture. Challenge timeouts and cancellations are handled explicitly.

### Scheduling and data handling
- Runs on the server: scheduled and on demand from the app. **Schedules are per connector type** and
  each connector declares its rate limits, which the scheduler enforces (a misconfiguration can never
  exceed a bank's limit). **[call]**
  - **PSD2 / Enable Banking:** at most 4 unattended fetches per account per 24 h (PSD2 RTS limit);
    default fixed times 06:00, 12:00, 18:00, 23:00 (household timezone). Fetches the user triggers by
    opening the app or tapping "sync now" are sent as user-present (PSU IP / headers forwarded) and do
    not count against the unattended limit. **[call]**
  - **FinTS:** default every 4 hours, configurable. **[call]**
  - **Experimental brokers:** per connector, conservative defaults. **[call]**
- Incremental via per-account cursors; idempotent upsert keyed on provider transaction id, falling back
  to a content hash when ids are unstable. Pending vs booked transactions are tracked; pending ones are
  reconciled when booked. **[call]**
- **Consent lifecycle:** PSD2 consents expire (typically 180 days) and FinTS occasionally requires a
  TAN confirmation. The app warns ahead of time (14 and 3 days before), via notification, and offers one-tap
  renewal. **[call]**
- Sync failures are visible per connector (last success, last error in plain language). **[call]**

## 7. Categorization

- Default German-household category set (Groceries, Eating out, Transport, Housing, Utilities,
  Insurance, Subscriptions, Shopping, Health, Kids, Savings/Investments, Income, …), editable. **[call]**
- Pipeline: (1) household rules (payee / IBAN / description pattern / amount → category),
  (2) learned matches from past corrections (same counterparty → same category),
  (3) built-in heuristics (MCC codes when available, known merchants), (4) "uncategorized".
  A correction offers "always do this for <counterparty>" which creates a rule. **[call]**
- **Internal transfers** between household accounts (incl. between members, and cash-to-depot) are
  detected (matching opposite amounts across known accounts within a few days) and excluded from
  spending and budgets. **[call]**
- All categorization runs locally on the server; no external AI. **[call]**

## 8. Budgets

- A budget = category (or group of categories) + amount + period (`weekly` ISO Mon–Sun, or `monthly`
  calendar). **[owner]**
- Budgets belong to the household. Each account has a **"counts toward household budgets"** flag,
  independent of visibility; default on for `household` accounts, off for `owner-only` accounts.
  Budgets are computed once per household, so every member sees the same numbers. **[owner]**
- No rollover in v1; history of past periods is kept and viewable. **[call]**
- Notification at 80% and 100% usage (configurable), delivered per §10. **[call]**

## 9. Net worth

- Sources: bank accounts (balances), depots (holdings valued by the connector-reported market value),
  experimental brokers, optional manual assets. **[owner]** / **[call]**
- Daily snapshot per source → history graph stacked by source; list of sources with current value
  and freshness. **[owner]**
- Multi-currency: values stored in original currency and converted to the household base currency
  (EUR default) using ECB reference rates (free). **[call]**

## 10. Security and encryption

Threat model **[owner]**: the server operator is trusted (self-hosting). Protect against: stolen server
disk, database dumps or backups, curious hosting provider, network attackers, lost/stolen phones,
leakage via logs and telemetry, and other household members for `owner-only` accounts.

Measures **[call]**:
- **Application-level envelope encryption** of sensitive fields: bank credentials and PINs, aggregator
  keys and tokens, broker sessions, transaction details (counterparty, purpose, amounts), balances and
  holdings. A per-household data key encrypts the data; a master key (env var / file / Docker secret,
  never in the database) wraps the data keys. Key rotation supported.
- Consequence: searching and aggregation over encrypted fields happen in the application layer;
  acceptable at household scale.
- Encrypted backups (same key hierarchy); setup forces saving a recovery copy of the master key.
  ⚠️ Lost key = lost data, documented prominently.
- TLS everywhere (the owner's instance is exposed over the internet via their ingress **[owner]**).
- **Auth (internet-facing):** passkeys, or password + mandatory TOTP; device-bound sessions revocable
  per device; rate limiting and lockout; invite-only.
- **Phone:** local cache encrypted with a key in Android Keystore; biometric/PIN app lock; no
  screenshots in the recents switcher.
- **Notifications (v1): no push service.** The app checks the owner's server in the background
  (Android-permitted interval, ~15–60 min), fetches pending notifications over TLS and shows them as
  local notifications. No third party is involved. **[owner]**
- **Extension point (later, opt-in): instant content-free pings** via a small project-run relay on
  FCM. A ping carries no data, only "wake up"; the app then fetches the content from its own server.
  The notification delivery is behind an interface so this can be added without changing callers.
  ⚠️ The relay is an operated, paid central component. **[owner]**
- Logs and traces never contain amounts, payees, IBANs, credentials (enforced by a redaction layer
  and tests).

## 11. Architecture and stack

TypeScript throughout. **[owner]**

- **Monorepo** (pnpm workspaces): `src/server`, `src/mobile`, `src/shared` (types, zod schemas,
  money/date logic), `tests/`, `ci/`, `docs/`. **[call]**
- **Server:** Node.js LTS, Fastify, zod-validated REST API with generated OpenAPI, Drizzle ORM,
  PostgreSQL, pg-boss for scheduled/background jobs (Postgres-backed, no Redis). **[call]**
- **Mobile:** Expo (latest SDK, development builds, not Expo Go), React Native, Android first. **[owner]**
- **Money:** integer minor units + ISO currency; never floating point. **[call]**
- **Observability:** OpenTelemetry (traces, metrics, structured logs with TraceId/SpanId) exported to
  the owner's otel-ingress-collector (OpenObserve/SigNoz); optional and off by default for other
  self-hosters. **[call]** Redaction per §10.
- Architecture diagram under `docs/architecture.md`. **[call]**

## 12. Self-hosting and deployment

- Deliverable: container image(s) + `docker compose` file bundling Postgres by default; any Postgres via
  connection string. **[call]**
- **Repo and CI:** public GitHub repository, GitHub Actions, images published to GHCR. **[owner]**
- Owner's instance: runs the same docker compose setup as other self-hosters **[owner]**, deployed to
  the owner's host (probably Horus) via a setup in the owner's separate `NME-IaC` repository (separate
  PR there, not part of this repo) **[owner]**; uses the existing `nme-pgsql` server with a dedicated
  database and user **[owner]**; exposed over the internet via the owner's existing ingress **[owner]**.
- **Operator tasks run through a server CLI** (`budgedino <command>` inside the container): bootstrap
  the first household and admin invite, generate and back up the master key (with forced
  confirmation of a saved copy), key rotation, and Enable Banking registration (a one-time per-server
  task: the CLI generates the key pair, prints what to paste into the Enable Banking portal, and
  verifies). Everything members do day to day happens in the app. **[call]**
- Documentation: install, Enable Banking registration, key backup/recovery, upgrade, restore.

## 13. Testing strategy

Strong testing is a core requirement. **[owner]** **[call]** on specifics:
- TDD for domain logic.
- **Unit:** Vitest; property-based tests (fast-check) for money, budgets periods, transfer detection,
  categorization precedence, deduplication.
- **Integration:** Testcontainers Postgres; encryption round-trips and "no plaintext at rest" checks
  on the real database.
- **Connector tests:** contract tests against recorded, anonymized fixtures; Enable Banking sandbox;
  a fake FinTS server for deterministic flows. Live-bank tests are opt-in and never in CI.
- **API end-to-end:** full server against fake connectors.
- **Mobile end-to-end:** Maestro flows on a physical Android device or the device farm (no emulator
  without explicit owner approval each time).
- Security tests: visibility enforcement (member cannot fetch `owner-only` data via any endpoint),
  log redaction.
- CI runs unit, integration, connector contract and API e2e on every PR.

## 14. Versioning

Semantic versioning via GitVersion 5.x, Mainline mode. **[call]** (owner default)

## 15. Spec-driven development **[owner]**

- `docs/specs/<area>.md`: living specs per area (household-and-access, sync-and-connectors,
  categorization, budgets, net-worth, security, self-hosting). Source of truth for behaviour. Every
  behavioural change updates the relevant spec in the same PR, before code.
- `docs/adr/NNNN-<title>.md`: decision records with context and rationale (seeded from this document:
  TypeScript stack, Enable Banking BYO key, unofficial broker connectors, envelope encryption,
  shared nme-pgsql).
- `AGENTS.md` at the root (with `CLAUDE.md` pointing to it): working rules (spec → tests → code),
  map of the repo, conventions. AI skills under `.ai/skills` symlinked from `.claude/skills` and
  `.codex/skills`.
- The owner may or may not review specs; specs land through PRs like code.

## 16. Left to the builder

- Exact API shape, DB schema, UI layout and visual design (follow the screens in §4).
- Scalable Capital connector approach (research first; document in an ADR).
- Trade Republic protocol port details.
- Category default list details and merchant heuristics.
- Order of implementation, as long as the first milestone delivers an end-to-end slice:
  one real connector → transactions → categories → one budget on the home screen.

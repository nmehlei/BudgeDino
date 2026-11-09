# AGENTS.md

BudgeDino: open-source (AGPL-3.0), self-hostable household finance app. TypeScript monorepo: server
now, Expo Android app later. Read this before changing anything.

## Workflow

**spec → failing test → code → spec updated in the same PR.**

- Specs in `docs/specs/<area>.md` are the source of truth for behaviour. Change the spec first.
- Decisions are recorded as ADRs in `docs/adr/NNNN-<title>.md` (Context / Decision / Consequences).
- **Every change goes through a PR.** No direct pushes to `main`.
- Commits use conventional commit messages. **No AI attribution** of any kind in commits, PRs or docs
  (no `Co-Authored-By`, no "Generated with" lines).
- AI skills live under `.ai/skills` and are symlinked from `.claude/skills` and `.codex/skills`
  (none yet; this is the convention).
- **Never start an Android emulator without the owner's explicit approval, every time.** Prefer a
  physical device or the device farm.

## Repo map

| Path                   | Content                                                                   |
| ---------------------- | ------------------------------------------------------------------------- |
| `src/shared`           | `@budgedino/shared`: types, zod schemas, money/date logic                 |
| `src/server`           | `@budgedino/server`: Fastify API, jobs, connectors                        |
| `src/mobile`           | Expo Android app (later)                                                  |
| `tests/`               | cross-package tests (`*.test.ts` unit, `*.int.test.ts` integration)       |
| `ci/`                  | scripts (`ci/check.sh`); GitHub requires workflows in `.github/workflows` |
| `docs/specs/`          | living per-area specs ([index](docs/specs/README.md))                     |
| `docs/adr/`            | decision records                                                          |
| `docs/architecture.md` | architecture diagram, stack, testing strategy                             |

## Commands

| Command                 | Purpose                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| `pnpm install`          | install (pnpm 12, Node 22+; CI uses `.nvmrc`)                                                                |
| `pnpm lint`             | ESLint (typescript-eslint strict)                                                                            |
| `pnpm typecheck`        | `tsc` in every workspace package                                                                             |
| `pnpm test`             | unit tests (Vitest `unit` project)                                                                           |
| `pnpm test:integration` | integration tests (Vitest `integration` project, `*.int.test.ts`; **needs Docker**, Testcontainers Postgres) |
| `pnpm test:e2e`         | end-to-end household slice through the real entry point (needs Docker)                                       |
| `pnpm test:build`       | builds, then smoke-tests `dist` with plain Node (needs Docker)                                               |
| `pnpm build`            | esbuild bundle of the server into `src/server/dist`                                                          |
| `pnpm openapi`          | builds and regenerates `docs/api/openapi.json`; commit the result (CI fails on drift)                        |
| `bash ci/check.sh`      | everything CI runs (`SKIP_INTEGRATION=1` skips the Docker-based suites: integration, e2e, build smoke)       |

Toolchain: no Node-26-only APIs (packages declare `engines.node >=22`). TypeScript is pinned to 6.x
until typescript-eslint supports TS 7.

## Global Constraints

- TypeScript throughout; strict mode; no `any` in domain code.
- Money: integer minor units + ISO 4217 currency; never floating point.
- Read-only bank access; no payment initiation.
- Sensitive fields (credentials, PINs, tokens, broker sessions, counterparty, purpose, amounts, balances, holdings, account names/IBANs) are encrypted at application level; the master key never lives in the database.
- Logs, traces and notification payloads never contain amounts, payees, IBANs or credentials.
- Every route declares `config.access` (`public` | `member` | `admin`); `buildApp` throws otherwise and attaches the guard itself (never add guards by hand).
- Adding a GET route requires a `tests/support/route-fixtures.ts` entry for each of its path parameters; the visibility harness (`tests/server/access/visibility.int.test.ts`) probes every registered GET route as another member and fails on a missing entry. It also requires the owner (member B) to get 2xx from every member/admin GET route, and parameterised routes to return one of B's canaries, so a wrong fixture cannot pass vacuously; a route that cannot satisfy this (e.g. admin-only) needs a commented entry in `OWNER_POSITIVE_CONTROL_EXEMPT` in the same file.
- Reads of accounts, transactions, splits and balances go through `visibleAccountIds(db, auth)`; repositories require its result.
- Visibility is enforced on the server; `owner-only` accounts are invisible to everyone but their owner, admins included.
- Connectors belong to the member who created them.
- Budgets: `weekly` = ISO Mon–Sun, `monthly` = calendar month, in the household timezone (default `Europe/Berlin`); no rollover; base currency EUR by default.
- Each account has `countsTowardBudgets` (default true for `household`, false for `owner-only`); budgets are computed once per household.
- PSD2 connectors: max 4 unattended fetches per account per 24 h, default times 06:00/12:00/18:00/23:00; user-present fetches don't count. FinTS: every 4 h default.
- The server never starts an interactive bank dialog on its own; it sets `needs_attention` and waits for the user.
- Repo layout: `src/`, `tests/`, `ci/` (scripts; GitHub requires workflows in `.github/workflows`), `docs/`.
- Every behavioural change updates the relevant `docs/specs/<area>.md` in the same commit/PR.
- No AI attribution in commits, PRs or docs.

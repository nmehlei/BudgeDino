# Spec: Self-hosting and deployment

- Status: living spec (source of truth for behaviour)
- Origin: [founding design](2026-11-08-budgedino-design.md) §12. **[owner]** = decided by the owner,
  **[call]** = AI's call, may be challenged.

- Deliverable: container image(s) + `docker compose` file bundling Postgres by default; any Postgres via
  connection string. **[call]**
- **Repo and CI:** public GitHub repository, GitHub Actions, images published to GHCR. **[owner]**
- License: AGPL-3.0 (see [ADR 0008](../adr/0008-agpl-license.md)).
- Owner's instance: runs the same docker compose setup as other self-hosters **[owner]**, deployed to
  the owner's host (probably Horus) via a setup in the owner's separate `NME-IaC` repository (separate
  PR there, not part of this repo) **[owner]**; uses the existing `nme-pgsql` server with a dedicated
  database and user **[owner]**; exposed over the internet via the owner's existing ingress **[owner]**.
  See [ADR 0007](../adr/0007-shared-nme-pgsql.md).
- **Operator tasks run through a server CLI** (`budgedino <command>` inside the container): bootstrap
  the first household and admin invite, generate and back up the master key (with forced
  confirmation of a saved copy), key rotation, and Enable Banking registration (a one-time per-server
  task: the CLI generates the key pair, prints what to paste into the Enable Banking portal, and
  verifies). Everything members do day to day happens in the app. **[call]**
- Documentation: install, Enable Banking registration, key backup/recovery, upgrade, restore.

## Configuration and process (implemented)

Code: `src/server/src/{config.ts,main.ts,instrument.ts}`. Build: `pnpm build` bundles `src/server` with
esbuild into `src/server/dist` (the sources use bundler-style imports Node cannot run unbundled;
`@budgedino/shared` is bundled, third-party packages stay external and are installed from `node_modules`;
`drizzle/` migrations are copied next to the bundle). Run with plain Node:
`node --import ./dist/instrument.js ./dist/main.js`; the `budgedino` CLI is `node dist/cli.js`.

**Startup order (`main`):** telemetry (a no-op without `OTEL_EXPORTER_OTLP_ENDPOINT`) -> config validation ->
logger -> master key -> database pool -> `migrate()` -> app -> pg-boss jobs (`sync.tick`, `challenges.expire`,
`fx.refresh` with the ECB source) -> listen. `SIGTERM`/`SIGINT` shut down gracefully: pg-boss stops, the
server stops accepting and drains running syncs, the pool closes, telemetry flushes. Invalid configuration
exits 1 with a message that names variables and rules, never values.

| Variable                                              | Default               | Meaning                                                                                                                    |
| ----------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                        | required              | `postgres://` / `postgresql://` connection string                                                                          |
| `BUDGEDINO_MASTER_KEY` or `BUDGEDINO_MASTER_KEY_FILE` | one required          | 32 bytes, base64; setting both is an error                                                                                 |
| `PORT`                                                | `8080`                | listen port                                                                                                                |
| `HOST`                                                | `0.0.0.0`             | listen address                                                                                                             |
| `BUDGEDINO_TRUST_PROXY`                               | off                   | hop count (`1`) or comma-separated proxy IPs/CIDRs; `true` is rejected                                                     |
| `BUDGEDINO_MAX_CONCURRENT_SYNCS`                      | `2`                   | process-wide cap on concurrent sync runs (1-20)                                                                            |
| `BUDGEDINO_CONNECTORS`                                | empty                 | comma list of enabled connector types; `fake` only when `NODE_ENV` is not `production` or `BUDGEDINO_ALLOW_FAKE=1`         |
| `BUDGEDINO_FINTS_PRODUCT_ID`                          | required with `fints` | FinTS product registration number from the Deutsche Kreditwirtschaft; see [guide](../guides/fints-product-registration.md) |
| `BUDGEDINO_FINTS_PRODUCT_VERSION`                     | `1.0`                 | product version sent to the bank with every dialog                                                                         |
| `LOG_LEVEL`                                           | `info`                | pino level                                                                                                                 |
| `OTEL_*`                                              | unset                 | standard OpenTelemetry variables; telemetry is on only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set                           |

**FinTS.** German banks only accept FinTS clients that send a product registration number (free, issued by the
Deutsche Kreditwirtschaft). Register BudgeDino following [the checklist](../guides/fints-product-registration.md),
then set `BUDGEDINO_FINTS_PRODUCT_ID` (and optionally `BUDGEDINO_FINTS_PRODUCT_VERSION`) and add `fints` to
`BUDGEDINO_CONNECTORS`; the server refuses to start without the id. FinTS dialogs live in process memory, so run a single
instance and expect a restart to drop open TAN challenges ([ADR 0009](../adr/0009-fints-in-memory-dialogs.md)). The
FinTS dependency `lib-fints` is LGPL-2.1-or-later and is used unmodified except for the patch in
`patches/lib-fints@1.5.3.patch`, published in this repository.

**Health.** `GET /api/v1/health` is public (`config.access: 'public'`) and answers `{ "ok": true, "version": "<server version>" }`
without touching the database or returning household data. The mobile app calls it to verify a server URL
during onboarding.

**OpenAPI.** `docs/api/openapi.json` is generated from the route schemas (`pnpm openapi`) and committed;
`ci/check.sh` regenerates it and fails when it differs, so API changes always ship with the updated document.

## Local development loop (implemented)

Development only; none of this runs in a production deployment. Step-by-step for a phone:
[run-on-android-device.md](../guides/run-on-android-device.md).

- **Database:** `pnpm dev:db` starts `docker-compose.dev.yml` (Postgres 18 on `127.0.0.1:5433`, throwaway
  credentials) and waits until it is healthy.
- **Server:** `pnpm dev:server` (`scripts/dev.sh server`) loads `.env.dev` if present, else
  `.env.dev.example` (no real secrets): `NODE_ENV=development`, `BUDGEDINO_CONNECTORS=fake`, `HOST=0.0.0.0`,
  `PORT=8080`, `DATABASE_URL` for the dev database. The master key is not in the env file: on first use the
  script generates one into `.dev/master.key` (gitignored, mode 600) and points `BUDGEDINO_MASTER_KEY_FILE`
  at it. Keep that file; the dev database is unreadable without it. The script refuses a caller-supplied `NODE_ENV=production` (checked before the env file is read) and always
  exports `NODE_ENV=development` itself; the env file does not set it. It warns on stderr while `HOST=0.0.0.0`
  (the default, overridable, e.g. `HOST=127.0.0.1`): the open interface plus fixed demo credentials means trusted Wi-Fi only.
- **Seed:** `pnpm dev:seed [-- --with-data]` runs `budgedino dev-seed`:
  - is **opt-in**: runs only with `NODE_ENV=development` (what `dev.sh` sets) or the explicit flag
    `--i-know-this-is-dev`; refuses (exit 2, before touching key or database) otherwise, and always in
    `NODE_ENV=production`, flag or not;
  - creates the household "BudgeDino Demo" once and prints a **fresh one-time admin invite on every run**
    (`invite_token`, `invite_expires_at`) plus the config the app's "Demo bank" sends
    (`{"scenario":"decoupled"}`, so connecting produces a decoupled challenge to confirm);
  - with `--with-data`: a demo admin member (`demo@budgedino.test`, fixed dev password), a connected
    `fake` connector with one account and ~60 days of generated German transactions (REWE, EDEKA, DB,
    Netflix, Lieferando, salary; deterministic, integer minor units), categorized by the normal categorizer,
    and two budgets: Groceries 500 EUR monthly and Eating out 60 EUR weekly. Re-running changes nothing
    except issuing another invite;
  - uses the production services (bootstrap, member and account repositories, ingest, categorizer), so
    all sensitive fields are encrypted as usual;
  - prints the invite, the demo credentials and the dev TOTP secret, because it is a dev-only seed (it
    says so on stderr). It never prints session tokens or the master key, and never transaction contents
    (only counts).
- **`BUDGEDINO_DEV_TOTP_SECRET`** (base32, test-only): the TOTP secret given to the demo member when the
  seed creates it (read only when `NODE_ENV` is not `production`; otherwise one is generated). The Maestro
  runner derives login codes from it.
- **Maestro** (`pnpm maestro:device`, opt-in, never in CI or `ci/check.sh`): runs
  `src/mobile/maestro/{login,home,connect-demo-bank}.yaml` against the USB-attached **physical** phone
  (the runner refuses when no physical device is attached; emulators are not supported).
- **App lock in E2E builds.** The Maestro flows relaunch the app, which the app lock would block. The lock is
  skipped only when the build is the development variant (`extra.allowCleartext`) **and** was prebuilt with
  `BUDGEDINO_E2E=1` (`extra.e2e`); release builds never honour it. A normal `pnpm mobile:android` restores the lock.

# Architecture

- Origin: [founding design](specs/2026-11-08-budgedino-design.md) §11, §13, §14. **[owner]** = decided
  by the owner, **[call]** = AI's call, may be challenged.

## Overview

What exists today (P1, server core). Dashed boxes are planned: the Android app (P3), real connectors
(P2, P4, P7) and net worth (P5).

```mermaid
flowchart LR
  app["Android app (Expo, planned)"]:::planned -->|"TLS, REST + OpenAPI, bearer session"| api
  cli["budgedino CLI (init-key, bootstrap, invite, rotate-master-key)"] --> keyring
  subgraph server["BudgeDino server (node dist/main.js)"]
    api["Fastify API /api/v1 (access guard per route, zod schemas)"] --> domain["Domain: households + visibility, budgets + alerts, categorization, FX, notifications"]
    api -->|"connect, answer challenge, user sync"| sync["Sync service (advisory lock per connector, generation guard)"]
    jobs["pg-boss jobs: sync.tick, sync.connector, challenges.expire, fx.refresh"] --> sync
    sync --> conn["Connector registry: FakeConnector (tests/dev); FinTS, Enable Banking, brokers planned"]
    sync -->|"ingest, then categorize, detect transfers, evaluate alerts"| domain
    domain --> keyring["Keyring: per-household data keys"]
    keyring --> enc["Envelope encryption (AES-256-GCM, AAD = table|column|row)"]
    jobs -->|"daily"| ecb["ECB reference rates"]
  end
  enc --> pg[("PostgreSQL: encrypted columns + blind indexes")]
  jobs -. "queue state" .-> pg
  conn -->|"read-only"| banks["Banks / brokers"]
  mk["Master key (env / file / Docker secret)"] -->|"wraps data keys"| keyring
  server -. "OTLP: http + pg spans, metrics, logs (redacted; only if OTEL_EXPORTER_OTLP_ENDPOINT set)" .-> otel["otel-ingress-collector"]
  classDef planned stroke-dasharray: 5 5
```

- The app talks only to its own server. Data fetching runs on the server; interactive bank steps are
  started by the user in the app and handled as typed challenges.
- Sensitive fields are encrypted at application level; the master key never lives in the database.
  Hierarchy: master key (env/file) wraps one data key per household; field encryption and blind indexes
  use HKDF subkeys of the data key ([security.md](specs/security.md)).
- Connectors sit behind one interface and are replaceable. The same `onIngested` hook runs after API-
  and job-triggered syncs.
- Startup (`main.ts`): telemetry, config, logger, master key, pool, migrations, app, jobs, listen.
  Process, build and configuration: [self-hosting.md](specs/self-hosting.md). The generated API
  document is committed at [api/openapi.json](api/openapi.json) (CI fails on drift).

## Stack **[call]** unless marked

TypeScript throughout. **[owner]**

- **Monorepo** (pnpm workspaces): `src/server`, `src/mobile`, `src/shared` (types, zod schemas,
  money/date logic), `tests/`, `ci/`, `docs/`.
- **Server:** Node.js LTS, Fastify, zod-validated REST API with generated OpenAPI, Drizzle ORM,
  PostgreSQL, pg-boss for scheduled/background jobs (Postgres-backed, no Redis).
- **Mobile:** Expo (latest SDK, development builds, not Expo Go), React Native, Android first. **[owner]**
- **Money:** integer minor units + ISO currency; never floating point.
- **Observability:** OpenTelemetry (traces, metrics, structured logs with TraceId/SpanId) exported to
  the owner's otel-ingress-collector (OpenObserve/SigNoz); optional and off by default for other
  self-hosters. Redaction per [security.md](specs/security.md).

## Testing strategy

Strong testing is a core requirement. **[owner]** **[call]** on specifics:
- TDD for domain logic.
- **Unit:** Vitest; property-based tests (fast-check) for money, budgets periods, transfer detection,
  categorization precedence, deduplication.
- **Integration:** Testcontainers Postgres; encryption round-trips and "no plaintext at rest" checks
  on the real database.
- **Connector tests:** contract tests against recorded, anonymized fixtures; Enable Banking sandbox;
  a fake FinTS server for deterministic flows. Live-bank tests are opt-in and never in CI.
- **API end-to-end:** the real entry point (`start`) against Testcontainers Postgres with only the fake
  connector (`pnpm test:e2e`, `tests/e2e/household-slice.e2e.test.ts`).
- **Build smoke:** `pnpm test:build` runs the bundled `dist` with plain Node (CLI help, config failure, OTel
  spans over OTLP against a mock collector).
- **Mobile end-to-end:** Maestro flows on a physical Android device or the device farm (no emulator
  without explicit owner approval each time).
- Security tests: visibility enforcement (member cannot fetch `owner-only` data via any endpoint),
  log redaction.
- CI runs unit, integration, connector contract and API e2e on every PR.

## Versioning

Semantic versioning via GitVersion 5.x, Mainline mode. **[call]** (owner default)

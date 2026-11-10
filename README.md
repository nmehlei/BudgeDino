# BudgeDino

Open-source, self-hostable household finance app. It pulls accounts, transactions and depot holdings
from banks and brokers automatically, categorizes transactions and shows them against household
budgets, without recurring manual work. Sensitive data is encrypted at application level.

Status: early development (server foundation). The Android app (Expo development build) lives in `src/mobile`; `pnpm mobile:android` installs it on a USB-attached phone (JDK 17 via `.mise.toml`; without mise set `JAVA_HOME` to a JDK 17, e.g. `export JAVA_HOME=/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home`; plus `ANDROID_HOME`; no emulator).

## Documentation

- [Founding design](docs/specs/2026-11-08-budgedino-design.md): intent and goals
- [Specs](docs/specs/README.md): living per-area specs, the source of truth for behaviour
- [Architecture](docs/architecture.md), [ADRs](docs/adr/)
- [AGENTS.md](AGENTS.md): working rules for contributors and AI agents

## Development

Requires Node 22+ (`.nvmrc` pins the version used in CI), pnpm 12 and Docker (integration, e2e and build
tests start a throwaway PostgreSQL with Testcontainers).

```sh
pnpm install
pnpm lint && pnpm typecheck && pnpm test   # unit
pnpm test:integration                      # Testcontainers Postgres
pnpm test:e2e                              # whole household slice through the real entry point
pnpm test:build                            # builds, then smoke-tests dist with plain Node
pnpm openapi                               # regenerates docs/api/openapi.json (commit it)
bash ci/check.sh                           # everything CI runs
```

Local dev loop on a phone (database, server with demo bank, demo seed, Maestro):
[docs/guides/run-on-android-device.md](docs/guides/run-on-android-device.md). Run `mise trust` once so
`.mise.toml` (JDK 17) applies.

```sh
pnpm dev:db && pnpm dev:seed -- --with-data && pnpm dev:server
```

Set `SKIP_INTEGRATION=1` to skip the Docker-based suites in `ci/check.sh`.

## Build and run

`pnpm build` bundles the server with esbuild into `src/server/dist` (details in
[self-hosting.md](docs/specs/self-hosting.md)); it runs on plain Node.

```sh
cp .env.example .env            # fill in, never commit
export $(grep -v '^#' .env | xargs)   # or pass the variables your own way
pnpm build
node --import ./dist/instrument.js ./dist/main.js   # run from src/server; same as: pnpm --filter @budgedino/server start
```

`--import ./dist/instrument.js` registers the OpenTelemetry ESM hook before the app loads; it does
nothing unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set. The server migrates the database on start and
shuts down gracefully on SIGTERM/SIGINT.

### Environment variables

| Variable                                              | Default               | Meaning                                                                                      |
| ----------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                        | required              | PostgreSQL connection string                                                                 |
| `BUDGEDINO_MASTER_KEY` or `BUDGEDINO_MASTER_KEY_FILE` | one required          | master key (32 bytes, base64); never both                                                    |
| `PORT` / `HOST`                                       | `8080` / `0.0.0.0`    | listen address                                                                               |
| `BUDGEDINO_TRUST_PROXY`                               | off                   | hop count or proxy IP/CIDR list when behind a reverse proxy (`true` is rejected)             |
| `BUDGEDINO_MAX_CONCURRENT_SYNCS`                      | `2`                   | concurrent bank syncs per process                                                            |
| `BUDGEDINO_CONNECTORS`                                | empty                 | enabled connector types; `fake` (not in production unless `BUDGEDINO_ALLOW_FAKE=1`), `fints` |
| `BUDGEDINO_FINTS_PRODUCT_ID`                          | required with `fints` | FinTS product id registered with the ZKA                                                     |
| `BUDGEDINO_FINTS_PRODUCT_VERSION`                     | `1.0`                 | product version sent to the bank                                                             |
| `LOG_LEVEL`                                           | `info`                | log level                                                                                    |
| `OTEL_EXPORTER_OTLP_ENDPOINT` and other `OTEL_*`      | unset                 | telemetry export (off unless the endpoint is set)                                            |

FinTS needs a product registration number from the Deutsche Kreditwirtschaft (free; step-by-step in
[docs/guides/fints-product-registration.md](docs/guides/fints-product-registration.md)). The FinTS library
`lib-fints` is LGPL-2.1-or-later, used unmodified except for the pnpm patch in `patches/`, which is published here.
An opt-in live script against a real bank runs with `pnpm fints:live` (see [AGENTS.md](AGENTS.md)); it is not part of CI.

Invalid configuration exits with code 1 and a message naming the variable, never its value.

### CLI

The `budgedino` binary is `src/server/dist/cli.js` (`node src/server/dist/cli.js --help`):

```sh
budgedino init-key                                   # print a new master key once; confirm you saved it
budgedino bootstrap --household "Smith family"       # household + one-time admin invite
budgedino invite --household <id> [--role member]    # further invite tokens
budgedino rotate-master-key --server-stopped         # old key from BUDGEDINO_MASTER_KEY, new from BUDGEDINO_NEW_MASTER_KEY
```

`rotate-master-key` refuses to run without `--server-stopped`: stop all running servers first, they hold the
old key and cannot read data after the rotation. Point `BUDGEDINO_MASTER_KEY` at the new key afterwards.

First start: `init-key`, store the key, `bootstrap`, start the server, then register in the app with the
printed invite token and set up TOTP. A lost master key means lost data; there is no recovery.

The API document is committed at [docs/api/openapi.json](docs/api/openapi.json).

## License

[AGPL-3.0-only](LICENSE)

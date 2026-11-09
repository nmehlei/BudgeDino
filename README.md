# BudgeDino

Open-source, self-hostable household finance app. It pulls accounts, transactions and depot holdings
from banks and brokers automatically, categorizes transactions and shows them against household
budgets, without recurring manual work. Sensitive data is encrypted at application level.

Status: early development (server foundation). An Android app (Expo) follows.

## Documentation

- [Founding design](docs/specs/2026-11-08-budgedino-design.md): intent and goals
- [Specs](docs/specs/README.md): living per-area specs, the source of truth for behaviour
- [Architecture](docs/architecture.md), [ADRs](docs/adr/)
- [AGENTS.md](AGENTS.md): working rules for contributors and AI agents

## Development

Requires Node 22+ (`.nvmrc` pins the version used in CI) and pnpm 12.

```sh
pnpm install
pnpm lint && pnpm typecheck && pnpm test
bash ci/check.sh   # everything CI runs
```

## License

[AGPL-3.0-only](LICENSE)

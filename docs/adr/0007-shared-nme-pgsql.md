# ADR 0007: Owner's instance uses the shared nme-pgsql server

- Status: accepted (owner decision), 2026-11-09

## Context

Self-hosters get a docker compose setup bundling Postgres. The owner already runs a shared PostgreSQL
server (`nme-pgsql`).

## Decision

The product supports any Postgres via connection string. The owner's instance runs the same docker
compose setup as other self-hosters but connects to `nme-pgsql` with a dedicated database and user. The
deployment lives in the owner's separate `NME-IaC` repository (separate PR there, not part of this
repo).

## Consequences

- The server must not assume a bundled database.
- Backups and upgrades of the owner's database follow the shared server's operations.
- Application-level encryption ([ADR 0004](0004-envelope-encryption.md)) means the shared server never
  holds readable sensitive data.

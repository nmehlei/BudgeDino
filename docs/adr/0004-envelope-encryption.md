# ADR 0004: Application-level envelope encryption

- Status: accepted, 2026-11-09 (threat model: owner; measures: AI's call)

## Context

Threat model: the server operator is trusted, but a stolen disk, database dump or backup, a curious
hosting provider, logs or telemetry must not reveal sensitive data (credentials, tokens, counterparties,
purposes, amounts, balances, holdings, account names/IBANs).

## Decision

Encrypt sensitive fields at application level with envelope encryption: a per-household data key
encrypts the data; a master key (env var, file or Docker secret, never in the database) wraps the data
keys. Key rotation is supported. Backups use the same hierarchy, and setup forces saving a recovery
copy of the master key.

## Consequences

- Searching and aggregation over encrypted fields happen in the application layer; acceptable at
  household scale.
- Lost master key means lost data; documented prominently.
- Integration tests check on the real database that no plaintext is stored.
- Logs and traces are protected by a separate redaction layer.

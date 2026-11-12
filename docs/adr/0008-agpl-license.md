# ADR 0008: AGPL-3.0 license

- Status: accepted (owner decision), 2026-11-09

## Context

BudgeDino is open source and self-hostable with no licensing costs. As a network service, a permissive
license would allow third parties to run closed hosted forks.

## Decision

License the project under the GNU Affero General Public License v3.0 (`AGPL-3.0-only`). The full text is
in `LICENSE`, and every `package.json` declares `"license": "AGPL-3.0-only"`. The owner chose it to
keep hosted forks open.

## Consequences

- Anyone offering a modified version over a network must publish their modifications under the AGPL.
- Dependencies must be license-compatible (e.g. `lib-fints` is LGPL-2.1, which is compatible).
- Some organizations avoid AGPL software; accepted.

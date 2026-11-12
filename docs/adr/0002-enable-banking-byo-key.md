# ADR 0002: Enable Banking with a bring-your-own key

- Status: accepted (owner decision), 2026-11-09

## Context

C24 and Revolut are reachable only through PSD2 account information services. GoCardless Bank Account
Data is closed to new signups (July 2025). Enable Banking offers a free "restricted/personal" mode for
own accounts, but each user must register their own application. BudgeDino must not impose licensing
costs or a mandatory paid third party on self-hosters.

## Decision

Use Enable Banking in restricted/personal mode. Each self-hoster registers their own Enable Banking
application. A one-time operator task in the server CLI generates the key pair, prints what to paste
into the Enable Banking portal and verifies the result. **[owner]**

## Consequences

- Setup has a manual one-time registration step per server; accepted as a necessary evil.
- No central aggregator account and no shared secrets across installations.
- PSD2 limits apply (4 unattended fetches per account per 24 h, 180-day consents); see
  [sync-and-connectors.md](../specs/sync-and-connectors.md).

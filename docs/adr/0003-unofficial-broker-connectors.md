# ADR 0003: Unofficial broker connectors are allowed, experimental and best effort

- Status: accepted (owner decision), 2026-11-09

## Context

Trade Republic and Scalable Capital offer no official API, and depot holdings are not reachable via
PSD2. Without them the net-worth view would miss a large part of the household's assets.

## Decision

Allow unofficial, reverse-engineered connectors (Trade Republic via a TypeScript port of the pytr
protocol; Scalable Capital approach to be researched and recorded in its own ADR). They are labelled
experimental in the UI, best effort, and not part of the v1 definition of done; they are built after
the core works. A phone-confirmed re-login (one tap) is accepted for them as an exception to the
no-manual-steps rule. On failure a source keeps its last known value, marked stale. **[owner]**

## Consequences

- These connectors may break without notice; staleness is shown instead of silently dropping to zero.
- Use may conflict with a broker's terms; this is documented for users.
- The connector interface isolates the rest of the system from their instability.

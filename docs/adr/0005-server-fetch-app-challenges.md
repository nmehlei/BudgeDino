# ADR 0005: Server fetches data, the app answers interactive challenges

- Status: accepted (owner decision), 2026-11-09

## Context

Banks require user interaction at times (consent renewal, TAN, re-login) while the owner wants no
routine manual work. Phones are not reliable places for scheduled fetching.

## Decision

Data fetching runs unattended on the server. Every interactive step runs in the app, started by the
user. The server never opens a bank dialog on its own: it sets the connector to `needs_attention` and
notifies its owner. On the user's action it opens the dialog and hands the app a typed challenge
(`redirect`, `decoupled`, `code`, `image`), keeping the dialog state for the challenge's duration.

## Consequences

- New bank quirks become new challenge types, not a new architecture.
- The server must manage dialog state with timeouts and cancellation.
- Unattended schedules respect each connector's declared rate limits.

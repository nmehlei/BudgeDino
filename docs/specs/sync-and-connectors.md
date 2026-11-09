# Spec: Sync and connectors

- Status: living spec (source of truth for behaviour)
- Origin: [founding design](2026-11-08-budgedino-design.md) §5 and §6. **[owner]** = decided by the
  owner, **[call]** = AI's call, may be challenged.

## Data sources and connectors

Pluggable connector architecture: each connector implements a common interface (list accounts,
fetch transactions since cursor, fetch balances, fetch holdings, auth/consent lifecycle, health).
Replacing a connector must not affect the rest of the system. **[owner]**

| Institution      | Data                                          | Route                                                           | Status                  |
| ---------------- | --------------------------------------------- | --------------------------------------------------------------- | ----------------------- |
| DKB              | accounts, transactions, depot                 | FinTS 3.0 PIN/TAN (decoupled TAN)                               | official                |
| Comdirect        | accounts, transactions, depot                 | FinTS 3.0 PIN/TAN                                               | official                |
| C24              | accounts, transactions                        | Enable Banking (PSD2 AIS)                                       | official via aggregator |
| Revolut          | accounts, transactions (incl. multi-currency) | Enable Banking                                                  | official via aggregator |
| Trade Republic   | cash, transactions, holdings                  | unofficial reverse-engineered API (port of pytr protocol to TS) | **experimental**        |
| Scalable Capital | holdings, transactions                        | unofficial (approach to be researched)                          | **experimental**        |

Further institutions come from the same connectors (any FinTS bank; any Enable Banking bank).

- **FinTS** via `lib-fints` (TypeScript, LGPL-2.1, tested with DKB and comdirect). **[call]**
- **Enable Banking** in free "restricted/personal" mode: each self-hoster registers their own Enable
  Banking application. The app provides a guided wizard (server generates the key pair, shows what to
  paste where, verifies the result). Accepted by owner as a necessary evil. **[owner]**
  See [ADR 0002](../adr/0002-enable-banking-byo-key.md).
- GoCardless Bank Account Data is closed to new signups (July 2025) — not used.
- **Unofficial connectors** are allowed. **[owner]** They are **best effort and not part of the v1
  definition of done**; they are built after the core works, and a phone-confirmed re-login (one tap)
  is accepted as an exception to the no-manual-steps rule for them. **[owner]** They are labelled experimental in the UI. When one
  fails, its source keeps its last known holdings/value (marked stale) instead of dropping to zero. **[call]**
  See [ADR 0003](../adr/0003-unofficial-broker-connectors.md).
- Revolut stocks and other non-payment assets are not reachable via PSD2; out of v1 unless a route
  appears. Manual asset entries (e.g. property, cash) are allowed as an explicit, optional feature. **[call]**

## Sync

### Where bank interaction runs **[owner]**

- **Data fetching runs on the server**: unattended, scheduled, within the consent's validity.
- **Every interactive step runs in the app, started by the user.** When a bank needs the user (expired
  consent, TAN, re-login), the server does _not_ start a dialog on its own. It marks the connector
  `needs_attention` and notifies the connector's owner. The user taps the notification or "reconnect";
  only then does the server open the bank dialog and hand the app a **typed challenge**:
  - `redirect` — the app opens the bank URL in a browser tab; the bank redirects back into the app via
    a deep link; the app posts the result to the server.
  - `decoupled` — "confirm in your bank app" (e.g. DKB); the app shows a waiting state, the server polls
    the bank.
  - `code` — TAN or SMS code entry.
  - `image` — photoTAN/chipTAN image plus code entry.
- The server keeps the bank dialog state for the duration of the challenge (minutes) and continues the
  same dialog with the user's answer, so the bank session and the user are in the same moment.
- Each connector declares which challenge types it can raise; new bank quirks become new challenge
  types, not a new architecture. Challenge timeouts and cancellations are handled explicitly.
- See [ADR 0005](../adr/0005-server-fetch-app-challenges.md).

### Scheduling and data handling

- Runs on the server: scheduled and on demand from the app. **Schedules are per connector type** and
  each connector declares its rate limits, which the scheduler enforces (a misconfiguration can never
  exceed a bank's limit). **[call]**
  - **PSD2 / Enable Banking:** at most 4 unattended fetches per account per 24 h (PSD2 RTS limit);
    default fixed times 06:00, 12:00, 18:00, 23:00 (household timezone). Fetches the user triggers by
    opening the app or tapping "sync now" are sent as user-present (PSU IP / headers forwarded) and do
    not count against the unattended limit. **[call]**
  - **FinTS:** default every 4 hours, configurable. **[call]**
  - **Experimental brokers:** per connector, conservative defaults. **[call]**
- Incremental via per-account cursors; idempotent upsert keyed on provider transaction id, falling back
  to a content hash when ids are unstable. Pending vs booked transactions are tracked; pending ones are
  reconciled when booked. **[call]**
- **Consent lifecycle:** PSD2 consents expire (typically 180 days) and FinTS occasionally requires a
  TAN confirmation. The app warns ahead of time (14 and 3 days before), via notification, and offers one-tap
  renewal. **[call]**
- Sync failures are visible per connector (last success, last error in plain language). **[call]**

## Connector interface (implementation summary)

Code: `src/server/src/connectors/types.ts`; challenge schemas shared with the app in
`src/shared/src/api/challenges.ts`. The registry is built with `createConnectorRegistry([...])` and
injected (no global); `get(type)` throws `UnknownConnectorError`.

- **Methods:** `startAuth(config, ctx)` and `continueAuth(dialog, answer, ctx)` return an `AuthStep`
  (`done` with new state, or a `challenge` plus server-side `dialog` state); `listAccounts(state, ctx)`;
  `fetchTransactions(state, accountRef, since, ctx)`. Metadata: `type`, `experimental`,
  `challengeKinds`, `rateLimit` (`maxUnattendedPerDay`, `defaultSchedule`).
- **Challenge kinds:** `redirect` (url + return scheme; answer = callback URL), `decoupled` (message +
  poll interval; answer = confirm), `code` (answer = code), `image` (image + code).
- **Failure reasons:** `fetchTransactions` never throws for bank-side problems; it returns
  `{ ok: false, reason: 'needs_attention' | 'rate_limited' | 'temporary', retryAfter? }`.
- **Decoupled polling:** `continueAuth` returning `{done:false}` with the same `decoupled` challenge
  means "still pending, poll again after `pollAfterMs`". Terminal failures throw
  `ConnectorAuthError` (`too_many_attempts` | `declined` | `timeout`); a client mistake (wrong answer
  kind, bad callback) throws `InvalidAnswerError` and leaves the dialog valid (maps to 4xx).
  Optional `cancelAuth` ends a dialog early; not-done steps may carry `expiresAt` (the server uses
  min(own TTL, expiresAt)).
- The server must serialise state writes per connector (concurrent per-account fetches each return
  state; last-writer-wins would lose updates).
- Config, state and dialog are opaque JSON (stored encrypted); dialog state never leaves the server.
- `FakeConnector` (scenarios in its file header) and the reusable `runConnectorContract` suite
  (`tests/server/connectors/contract.ts`) back all sync/challenge tests and future connectors.

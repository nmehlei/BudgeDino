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
  See [FinTS connector](#fints-connector-implementation-summary) and [ADR 0009](../adr/0009-fints-in-memory-dialogs.md).
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
  - `image` — photoTAN image (`imageBase64` + `mimeType`, PNG or JPEG) plus code entry.
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
  `fetchTransactions(state, accountRef, since, ctx)` (plus an optional trailing `config`, below). Metadata: `type`, `experimental`,
  `challengeKinds`, `rateLimit` (`maxUnattendedPerDay`, `defaultSchedule`).
- **Challenge kinds:** `redirect` (url + return scheme; answer = callback URL), `decoupled` (message +
  poll interval; answer = confirm), `code` (answer = code), `image` (base64 image + `mimeType` `image/png`|`image/jpeg`, plus code entry).
- **Failure reasons:** `fetchTransactions` never throws for bank-side problems; it returns
  `{ ok: false, reason: 'needs_attention' | 'rate_limited' | 'temporary', retryAfter? }`.
- **Config on every call:** `listAccounts(state, ctx, config?)` and
  `fetchTransactions(state, accountRef, since, ctx, config?)` receive the connector's decrypted config
  (the server decrypts it once per run / discovery), so credentials never need to live in `state`.
  `FetchResult` success carries `state` only when it actually changed.
- **FinTS fetching:** unattended fetches request at most the last 89 days (inside the PSD2 90-day
  SCA exemption; the window is the Europe/Berlin calendar date, sent as UTC-midnight dates because
  lib-fints encodes dates in UTC). Each fetch is exactly one bank order; the balance is the closing
  balance from that statement response. A TAN demand or PIN error on a fetch is `needs_attention`
  (never an open dialog); network, 5xx and unparseable statements are `temporary` (a parse failure is
  never reported as an empty success). Credentials come from the config, not the state.
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

## FinTS connector (implementation summary)

Code: `src/server/src/connectors/fints/` (`connector.ts` has the full algorithm in its header). Decision record:
[ADR 0009](../adr/0009-fints-in-memory-dialogs.md). Enabled with `BUDGEDINO_CONNECTORS=fints` plus a registered
product id (`BUDGEDINO_FINTS_PRODUCT_ID`, see [the registration guide](../guides/fints-product-registration.md)).
Banks: DKB and Comdirect (`banks.ts`: BLZ and endpoint; the catalog URL is pinned into the session's BPD before and
after every bank call, so neither a stored BPD nor the bank's HIKOM announcement redirects the PIN).
Connection config (encrypted): `{bank, userId, pin, tanMethodId?}`. State: `{bankingInformation, tanMethodId, tanMediaName?, systemId}`.

- **TAN method preference:** the configured `tanMethodId` if the bank offers it, else decoupled (app approval) > code
  (SMS/push TAN) > photoTAN. chipTAN with flicker/optical cannot be rendered and is never selected; a bank offering only
  that is `declined`.
- **Auth:** BPD/UPD sync, TAN method selection, then a second sync. A TAN demand becomes a `decoupled` (poll after 3 s),
  `code` or `image` (PNG/JPEG, photoTAN methods only) challenge; an empty TAN is an `InvalidAnswerError` that leaves the
  dialog usable. The poll interval follows the bank's BPD (`waitingSecondsBeforeFirstStatusRequest` for the first poll,
  `waitingSecondsBetweenStatusRequests` afterwards), clamped to 2-10 s, default 3 s; a status response without a TAN
  reference keeps the pending one. Wrong PIN or locked access (answer codes 9910, 9931, 9942, 3938) is `declined`;
  a rejected TAN allows up to 3 attempts; any other failure is a generic `fints_failed` (502). Bank text never reaches
  errors; only the sanitised TAN challenge message does.
- **Transient errors keep the challenge:** a network, 5xx or decode failure of the TAN continuation call puts the live
  bank session back under the same handle, so a retry (after the 503) continues the same dialog. Terminal outcomes
  (declined, too many attempts, bank logic failure, corrupt config) end it, and so does any failure after the bank
  accepted the TAN (probe, TAN medium): its reference is used up, the user reconnects.
- **Statement support:** `listAccounts` skips accounts for which the bank offers no statements (account HKKAZ/HKCAZ or
  card HKKKU/DKKKU); depots stay listed. A credit card without card statements but with account statements is fetched
  via the account path. A fetch on an account without support is an empty success.
- **TAN medium:** if the selected method requires a TAN medium, the single active medium is selected after the SCA sync
  (several active: the first; the user cannot choose yet) and its name is stored as `tanMediaName` and used on reopen.
- **SCA probe:** after sync, a 3-day statements fetch on the first checking account that supports statements, else the
  first such credit card (no probe if there is none). If the bank demands a TAN
  for it, a second challenge is raised so the user's strong authentication covers account access, which enables later
  unattended fetches under the PSD2 90-day exemption.
- **First window:** the first fetch (no `since`) and any longer look-back are clamped to the last **89 days** (Europe/Berlin
  calendar date), inside the SCA-exempt window. Consent is recorded as expiring after 90 days.
- **`needs_attention` semantics:** a TAN demanded on a fetch, a PIN error, or unusable stored state/config (corrupt BPD,
  missing config, unknown account), a bank answer in 9930-9942 or 3938, or a rejected dialog init (the order never ran)
  is `needs_attention` so scheduled runs stop until the user reconnects (lockout protection): the server never opens an interactive dialog on its own, the user
  reconnects. Network errors, 5xx and unparseable statements are `temporary`.
- **Single-instance dialogs:** the bank session of an open challenge is held in an in-process registry (not serialisable);
  the persisted dialog carries only an opaque handle. The challenge expires after 10 minutes, registry entries live at most 15 (restoring renews), are swept every 60 s and dropped on
  shutdown; a restart drops open challenges (the user restarts the connection). Run one server instance.
- **Dependency:** `lib-fints` (LGPL-2.1-or-later), patched via `patches/lib-fints@1.5.3.patch` (no console dumps of bank
  responses, parse failures surfaced, raw CAMT dates). Regenerate the patch on upgrades.
- **Live script:** `pnpm fints:live` (opt-in, real bank, never in CI): set `FINTS_LIVE_BANK`, `FINTS_LIVE_USER`,
  `FINTS_LIVE_PIN`, `BUDGEDINO_FINTS_PRODUCT_ID`. TAN input is hidden on a terminal. It prints only the challenge kind and
  message, whether the selected TAN method requires a TAN medium and the count of active media, account count and kinds,
  and the first checking account's 30-day transaction count and booking date range.

## Connect, reconnect and challenges (implementation summary)

Code: `src/server/src/connectors/{routes.ts,challenge-service.ts}`; schemas in `src/shared/src/api/{challenges,connectors}.ts`.

- **Routes (member, owner only; anyone else gets 404):** `POST /connectors {type, config, accountDefaults?}` -> `{connectorId, challenge?}`
  (config validated by the connector's `configSchema`, unknown type or invalid config = 400, stored encrypted; the connector
  starts as `needs_attention`); `POST /connectors/:id/reconnect` -> `{challenge?}`; `POST /challenges/:id/answer` ->
  `{status, reason?, challenge?}`; `GET /challenges/:id` -> `{status}` (never calls the bank; a lazily detected expiry only marks the row `expired`); `DELETE /challenges/:id` cancels.
  The server never starts a dialog by itself. The sweeper (not a request) calls `cancelAuth` best-effort, once
  (`challenges.cancel_attempted`), for challenges that expired lazily.
- **Storage:** one encrypted envelope per challenge row (`payload_enc`): `{challenge, dialog, invalidAnswers, lastPollAt}`.
  Responses carry `{id, expiresAt, ...challenge}` only, never the dialog.
- **TTL:** min(10 min, `step.expiresAt`), renewed by a not-done step. Expiry is checked lazily on every challenge request and by
  the `challenges.expire` pg-boss job (every minute); both also expire `answering` rows past their TTL (crash recovery),
  call `cancelAuth` best-effort and leave the connector `needs_attention`.
- **Answering:** conditional `open -> answering` claim (no DB transaction across the bank call; a concurrent answer gets 409),
  result written back only while the claim is held. `InvalidAnswerError` = 422 `invalid_answer`, challenge stays open; the 5th
  ends it (`cancelled`, `too_many_invalid_answers`). `ConnectorAuthError` = 200 `{status: cancelled|expired, reason}`.
  Decoupled: the app POSTs `{kind:'decoupled'}` repeatedly; earlier than `pollAfterMs` after the last bank call = 429 with
  `Retry-After`, no bank call.
- **Lifetime:** a challenge never outlives createdAt + 15 min regardless of renewals. A decoupled challenge's first poll also
  waits `pollAfterMs` from creation. The sweeper treats an `answering` claim as abandoned only 2 min after its expiry and
  calls `cancelAuth` with `userPresent: false`.
- **Failure on a reconnect of an `ok` connector** (terminal `ConnectorAuthError`, expiry, cancel) leaves it `ok`: the old
  consent is still valid. A fresh connector stays `needs_attention`. If `startAuth` fails on `POST /connectors`, the
  just-created connector row is deleted (the client never got its id), so retries do not pile up duplicates.
- **State writes vs. sync (generation guard, no lock wait):** the done write is one atomic update that bumps
  `connectors.state_generation`; it never waits for a running sync or the sync slots. A run records the generation it
  started with (`sync_runs.connector_generation`) and only writes state, status, `last_error_code` or the error-streak
  `error` flip while that generation is current (a superseded run logs, writes nothing, notifies nobody and ends
  `skipped`, or `error` when it crashed). A reconnect resets the error streak: only runs of the current generation count.
  The generation comes from the same row read as the state the run works on. A guarded write that matches no row (also
  the `needs_attention` flip and its notification, and the success update) ends the run `skipped`, never notifies. If a
  post-connect sync request had coalesced onto a run that ends superseded (`sync_runs.follow_up`), one fresh user-present
  run follows immediately after it (the 2-minute throttle does not apply to that follow-up), so the new authentication is
  used right away.
- **At most one open challenge per connector;** a new reconnect cancels the previous one (`cancelAuth`).
- **On `done`:** state stored encrypted, connector `ok`, `consent_expires_at` set, accounts discovered with `listAccounts`
  (new refs matched by blind index get the connector's `accountDefaults`: visibility `household` and counting toward
  budgets unless `POST /connectors` said otherwise; `owner_only` without `countsTowardBudgets` means not counting),
  so a member can connect a private bank without its accounts ever being visible to the household. Then a user-present sync is started
  (coalescing applies; a throttled 429 does not fail the connect).

## Delete, rename and bank id (implementation summary)

Code: `src/server/src/connectors/{remove.ts,bank.ts,bank-backfill.ts}`, `routes.ts`; schemas in `src/shared/src/api/connectors.ts`.

- **`DELETE /connectors/:id?mode=keep|purge`** (member, owner only; anyone else, admins included, and unknown ids get 404;
  `mode` is required). 204 on success. Open challenges are cancelled first (best-effort `cancelAuth`). The delete then runs
  while holding the connector's sync advisory lock, so it waits for a running sync and no sync interleaves with it; a run
  queued behind it finds no connector and ends `skipped` without writing and without a run row; a scheduled job whose
  connector vanished between its start and the run-row insert (FK violation) also completes as `skipped`, never as a failure.
  Credentials, state, sync runs and challenges go with the connector row.
  - `keep` **[owner]**: the accounts stay with `connector_id = null` and `disconnected_at` set; they and their transactions
    keep counting toward budgets, balances and net worth. **Re-link [call]:** connecting the same bank again for the same
    owner re-attaches a disconnected account instead of creating a second one: `createAccount` first looks for an account of
    the same household and owner with `connector_id IS NULL` and the same `external_ref_bidx`, sets its new `connector_id`,
    clears `disconnected_at`, keeps its visibility and `countsTowardBudgets` (the new connector's account defaults only apply
    to new accounts) and returns it, so the normal transaction dedup applies: no duplicate account, no duplicate
    transactions, the balance counts once in net worth. Another member's disconnected accounts are never re-linked.
  - `purge` **[owner]**: additionally deletes the accounts with their transactions, splits, dedup aliases and balances.
    **Transfer partners [call]:** in the same database transaction, before the accounts go, the surviving halves of transfer
    pairs that reach into the purged accounts lose their `transfer_group_id` (and a non-manual Transfer category the pairing
    set), so they count toward budgets again and can be paired anew. After the purge the ingest hook (categorize, detect
    transfers, budget alerts) runs for those rows, best effort.
- **Account household [call]:** `accounts.household_id` (backfilled from the connector) replaces the join through
  `connectors` for household scoping, because a disconnected account has no connector. `visibleAccountIds` and the
  repositories scope by it. `AccountInfo.connectorId` is nullable and `AccountInfo.disconnected` says so.
- **`PATCH /connectors/:id {displayName}`** (member, owner only, 404 otherwise): trimmed 1 to 60 characters, stored
  encrypted (`connectors.display_name_enc`; it may name a bank or a person). `null` clears it. Returns the connector info.
- **`ConnectorInfo`** gains `bank` (non-secret bank id: `dkb`, `comdirect`, `fake`; the connector type when the connector has
  no bank concept) and, for the owner only, `displayName` (nullable). Other members' entries carry `bank` but no
  `displayName` (it may reveal a person). `connectors.bank` is a plaintext column written at create time from the config.
  **Backfill [call]:** a one-time startup step (`backfillConnectorBanks`, after the SQL migrations) decrypts the config of
  rows without `bank` once and writes it; rows that cannot be decrypted or name an unknown bank get the connector type as `bank`, so they are not rescanned on
  every startup.
- **Indexes:** `accounts_household` (migration 0012) on `accounts.household_id`, the household scoping column.

## Bank icons (implementation summary)

Code: `src/server/src/connectors/bank-icons.ts`, route in `connectors/routes.ts`; `iconUrl` per bank in `connectors/fints/banks.ts`.

- **`GET /banks/:bank/icon`** (member): the bank's logo as an image (`image/png|jpeg|webp|gif`), `Cache-Control: private,
max-age=86400` so the app caches it, and `X-Content-Type-Options: nosniff`. 404 for an unknown bank, a bank without an icon (`fake`), or a failed fetch. No
  trademarked image files live in the repo **[owner]**: the server fetches the logo lazily from the bank's official site.
- **No SSRF [call]:** the URL comes only from the fixed allow-list in `banks.ts` (`iconUrl`, https, official domain), never
  from user input. Redirects are followed manually (at most 3) and only to https URLs on the same host. The body is read as a
  stream and aborted once it exceeds 256 KiB (5 s timeout); the body of a redirect response is cancelled before following it.
  **Magic bytes [call]:** the type is derived from the bytes (PNG, JPEG, GIF, WebP) and that derived type is what is stored
  and served; the upstream `Content-Type` is ignored. Anything else (SVG, HTML, ...) counts as a failed fetch. Stored rows
  are re-checked on read; a row that is not a known raster format is treated as missing.
- **Cache:** table `bank_icons` (`bank`, `content_type`, `data`, `fetched_at`), TTL 30 days. A failed refresh serves the stale
  copy when there is one; every failed fetch, with or without a copy, is remembered in memory for 10 minutes (no
  hammering), then retried.

## Sync engine (implementation summary)

Code: `src/server/src/sync/` (`run.ts`, `ingest.ts`, `rate-guard.ts`, `scheduler.ts`, `jobs.ts`, `routes.ts`).

- **`runSync(connectorId, trigger, ctx)`** runs one connector under a session-level advisory lock
  (`pg_advisory_lock` on a dedicated connection; no DB transaction is open during bank HTTP), so scheduled and
  user-triggered runs never interleave state writes. Connector state (`connectors.state_enc`, encrypted) is
  committed right after **every** `FetchResult`, successful or not, and survives a later failure in the same run;
  ingest of each account is its own short transaction. The bank reference of each account is stored encrypted
  (`accounts.external_ref_enc`, written at account creation), so a run never calls `listAccounts` (account
  discovery happens after auth).
- **Concurrency:** at most 2 sync runs per process at once by default (`setMaxConcurrentSyncs`, set from `BUDGEDINO_MAX_CONCURRENT_SYNCS` at startup); further runs wait for a
  slot before taking any DB connection. The pool fails connection waits after 10 s. A lock connection whose
  unlock fails is destroyed, never returned to the pool.
- **Error streak:** 3 consecutive `error` runs set the connector to `error` (the scheduler skips it) and notify
  the owner once; a successful user run restores `ok`.
- **User syncs:** a request while a run of that connector is queued or active (no outcome, started < 15 min ago)
  returns that run's id with 202 (coalescing); user runs are spaced at least 2 minutes apart per connector
  (otherwise 429 `sync_throttled` with `Retry-After`).
- **Cursor:** `since` = min(latest booked `booking_date` of the account, today in the household timezone) minus 7 days (late bookings; the cap keeps a future-dated row from skipping them), or `null` on
  the first sync.
- **Triggers:** `schedule` runs only touch `ok` connectors and count against `maxUnattendedPerDay`
  (rolling 24 h over `sync_runs`; runs the guard or a status check skipped do not count). The 5th run is
  recorded with `outcome='rate_limited'`. `user` runs (`POST /connectors/:id/sync`, owner only, 202 `{runId}`)
  are not counted and pass `userPresent: true` plus the request IP as `psuIp`.
- **Outcomes** (`sync_runs.outcome`): `ok`, `needs_attention`, `temporary`, `bank_rate_limited`,
  `rate_limited`, `skipped`, `error`. `connectors.last_error_code` holds only stable codes
  (`needs_attention`, `bank_temporary`, `bank_rate_limited`, `unknown_connector`, `sync_failed`), never a bank
  or exception message.
- **needs_attention:** the connector flips to `needs_attention` and the owner gets one
  `connector_attention` notification (encrypted body naming only the connector type, no amounts, payees or
  IBANs). Only the transition notifies, so there is one notification while it stays in that state. The server
  never starts a dialog on its own.
- **Ingest dedup:** identity = provider id, else sha256 of `bookingDate|amount|currency|counterpartyIban|purpose`
  (identical content twice in one batch keeps two rows). Pending to booked: a booked transaction without a
  match takes over a pending row of the same account when the counterparty blind index is equal, the amount is
  within 25 % of the pending amount and it is booked 0 to 7 days after the pending date; the row keeps its id and
  category. The absorbed pending key is kept as an alias (`transaction_dedup_aliases`), so a bank that keeps
  reporting the pre-authorisation neither re-inserts nor downgrades the booked row; within a batch pending
  entries are processed before booked ones; a booked row is never downgraded to pending, also not by a
  pending report with the same provider id. When an update changes a row's amount or currency its splits
  (which would no longer sum) are deleted; the category stays. Pending rows older than 14 days that a fetch no longer reports are deleted (stale pre-auths).
- **Scheduler:** `nextRuns(schedule, timeZone, from)` supports `{times: ['HH:MM']}` (household-local) and
  `{cron}` (evaluated in the household time zone). pg-boss queues: `sync.tick` (every 5 minutes, enqueues due
  `ok` connectors) and `sync.connector` (policy `exclusive`, `singletonKey: connectorId`). `startJobs(deps, ...)`
  wires them (plus `challenges.expire` every minute and, with an `fxSource`, `fx.refresh` daily; the production entry `main.ts` passes the ECB source and the same `onIngested` hook as the API); `onIngested(householdId, txIds)` is called once per run after commit (categorizer hook).
- **`GET /connectors/types`** (member): `{types: string[]}`, the connector types the server has enabled
  (`BUDGEDINO_CONNECTORS`, from the connector registry). The app uses it to show "Demo bank" only when `fake` is enabled.
- **`GET /connectors`:** own connectors with status, `lastSuccessAt`, `lastErrorCode`, `consentExpiresAt`,
  `type`, `experimental`; others' connectors behind household-visible accounts only as
  `{id, type, status, lastSuccessAt}`.

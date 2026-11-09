# ADR 0009: FinTS dialogs live in process memory; lib-fints is patched and pinned

- Status: accepted, 2026-11-09

## Context

The `fints` connector uses [`lib-fints`](https://github.com/robocode13/lib-fints) (LGPL-2.1-or-later) to talk
FinTS 3.0 PIN/TAN to DKB and Comdirect. Two properties of the library shape the design:

- **The dialog is not serialisable.** A FinTS dialog is an open, stateful session (system id, message
  numbers, the pending TAN reference, the bank's security parameters, the PIN in its config). The
  connector contract keeps dialog state as encrypted JSON in the database so a challenge can be answered
  from any request; a lib-fints dialog cannot be rebuilt from JSON mid-flight.
- **It leaks and guesses.** It writes bank responses (account numbers, IBANs) to the console, swallows
  MT940/CAMT parse failures as "success with zero statements", and loses the bank's written dates by
  converting them to `Date` objects.

## Decision

- **In-process dialog registry.** Live lib-fints sessions are held in a process-wide `FinTSDialogRegistry`
  (`src/server/src/connectors/fints/dialogs.ts`). The persisted `DialogState` carries only an opaque handle
  (32 random bytes, base64url) plus non-secret bookkeeping (kind, step, attempts, TAN method id). An entry
  is taken once while it is resumed and put back under the same handle (`restore`) when the TAN continuation call itself fails
  transiently (network, 5xx, decode), so a client retry reaches the same session. The challenge the client
  sees expires after 10 minutes (`expiresAt`); the registry itself keeps an entry for at most 15 minutes
  (restoring gives a fresh registry lifetime), is capped (oldest evicted), swept every 60 s by an unref'd
  timer and cleared on shutdown. Sessions and credentials never reach JSON, logs or `inspect`.
- **Single instance.** The registry is local to one server process, so BudgeDino runs as one instance
  (already the self-hosting model). A restart drops every open challenge; the user simply starts the
  connection again (a pending TAN is re-requested). The server never starts an interactive dialog on its
  own, so nothing unattended is lost.
- **Patched, unmodified otherwise.** `lib-fints` is used as published except for the pnpm patch
  `patches/lib-fints@1.5.3.patch` (registered in `pnpm-workspace.yaml`). It removes the console dumps of bank
  responses, surfaces parse failures (`parseFailed`, mapped to a `decode` port error and then `temporary`),
  keeps the raw CAMT date strings (P2-R9), and flags an order result that is really the dialog init
  response (dialog initialisation did not complete: rejected or demanded a TAN) (`initFailed`, which lib-fints otherwise returns indistinguishably). The patch is published in this repository, which satisfies
  the LGPL's source-availability requirement for the modified library. Because the repository is AGPL-3.0,
  the combination is licence-compatible (see ADR 0008). **The patch must be regenerated (`pnpm patch`) on
  every lib-fints upgrade**; the version in the patch file name pins it.
- **Catalog URL pinning (P2-R4).** The PIN is sent to the bank endpoint. lib-fints reads `bpd.url ?? url`
  and overwrites `bpd.url` from the bank's HIKOM on every sync, so neither a stored BPD nor an
  announcement may redirect it. Each `LibFintsSession` keeps the operator-controlled catalog URL
  (`banks.ts`) and rewrites it into `bankingInformation.bpd.url` when it is opened and before and after
  every bank call (synchronize, synchronizeWithTan, each order). Later dialogs of the same session and the
  stored snapshot therefore always carry the catalog URL. A differing BPD URL (stored or announced) only
  reports the BLZ once per session (`onUrlMismatch`).
- **Balance from statements (P2-R8).** The balance is the closing balance of the statement response. No
  separate balance order is sent, since an extra order can trigger an unexplained TAN push on scheduled runs.
- **Config passed to fetch (P2-R7).** `listAccounts` and `fetchTransactions` receive the decrypted
  connection config as a trailing argument, so the PIN and user id live in one place (the encrypted config)
  and not in the connector state that is rewritten on every fetch.
- **Exact per-source dates (P2-R9).** Booking dates are the bank's calendar days as `YYYY-MM-DD`, decided per
  source (CAMT raw string; MT940 and credit card via local date getters) instead of guessed from a `Date`.

## Consequences

- Restarts, deployments and crashes abort pending TAN dialogs; users re-initiate the connection.
- Horizontal scaling is not supported for FinTS (a second instance cannot resume the first one's dialog).
- A bank endpoint migration needs a catalog update before syncs work again, as the announced BPD URL is
  ignored.
- Fetches treat an incomplete dialog init (`initFailed`: rejected or TAN demanded) and answer codes 9930-9942 and 3938 as
  `needs_attention`, so scheduled runs stop instead of repeating a request that may lock the access.
- A required TAN medium is selected after the SCA sync (the single active medium; with several, the first:
  the user cannot choose yet) and its name is kept in the connector state.
- Each lib-fints upgrade costs a patch regeneration and a review of the patched behaviour.
- A FinTS product registration (DK) is required to run the connector; see
  [the registration guide](../guides/fints-product-registration.md).
- The opt-in live script (`pnpm fints:live`) is the only check against a real bank; it is never run in CI.

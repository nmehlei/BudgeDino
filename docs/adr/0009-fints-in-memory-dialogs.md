# ADR 0009: FinTS dialogs live in process memory; lib-fints is patched and pinned

- Status: accepted, 2026-11-09

## Context

The `fints` connector uses [`lib-fints`](https://github.com/larsdecker/lib-fints) (LGPL-2.1-or-later) to talk
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
  is taken once, expires after 10 minutes, the registry is capped (oldest evicted), swept every 60 s by an
  unref'd timer and cleared on shutdown. Sessions and credentials never reach JSON, logs or `inspect`.
- **Single instance.** The registry is local to one server process, so BudgeDino runs as one instance
  (already the self-hosting model). A restart drops every open challenge; the user simply starts the
  connection again (a pending TAN is re-requested). The server never starts an interactive dialog on its
  own, so nothing unattended is lost.
- **Patched, unmodified otherwise.** `lib-fints` is used as published except for the pnpm patch
  `patches/lib-fints@1.5.3.patch` (registered in `pnpm-workspace.yaml`). It removes the console dumps of bank
  responses, surfaces parse failures (`parseFailed`, mapped to a `decode` port error and then `temporary`),
  and keeps the raw CAMT date strings (P2-R9). The patch is published in this repository, which satisfies
  the LGPL's source-availability requirement for the modified library. Because the repository is AGPL-3.0,
  the combination is licence-compatible (see ADR 0008). **The patch must be regenerated (`pnpm patch`) on
  every lib-fints upgrade**; the version in the patch file name pins it.
- **Catalog URL pinning (P2-R4).** The PIN is sent to the bank endpoint, and the BPD stored from an earlier
  response must not be able to redirect it. The operator-controlled catalog URL (`banks.ts`) always wins; a
  mismatch only logs a warning with the BLZ.
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
- A bank endpoint migration needs a catalog update before syncs work again, as the BPD URL is ignored.
- Each lib-fints upgrade costs a patch regeneration and a review of the patched behaviour.
- A FinTS product registration (DK) is required to run the connector; see
  [the registration guide](../guides/fints-product-registration.md).
- The opt-in live test (`pnpm test:live`) is the only check against a real bank; it is never run in CI.

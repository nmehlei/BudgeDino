# Spec: Mobile app

The Expo Android app (development build, never Expo Go) talks to one self-hosted server.

## Mobile onboarding

- **Server URL.** The user enters the server address; "Check" calls the public `GET /api/v1/health`
  before continuing. The URL is normalised: scheme and host lowercased, trailing slashes and a pasted
  `/api/v1` removed, any other path kept. Only `https://` is accepted; `http://` is accepted only in the
  development variant (`extra.allowCleartext`, which also enables Android cleartext traffic). Release
  builds reject it.
- **Registration.** Invite token, email, display name, password (minimum 12 characters, strength hint)
  and device name (prefilled from the device model) go to `POST /auth/register`. The next screen shows
  the TOTP QR code and the secret for manual entry; a 6-digit code confirms and stores the session token
  (expo-secure-store only).
- **TOTP secret handling.** The provisioning URI is held in memory only (never in route params, MMKV
  or the query cache), is shown once, and is cleared when the TOTP screen is left. "Copy secret" puts the
  secret on the clipboard and overwrites it with an empty string after about 60 seconds (best effort),
  also when the screen was already left; copying again restarts the 60 seconds. The screen says so. The password field is cleared as soon as registration or login succeeds.
- **Login.** Email, password and a 6-digit code (digits only). Every failure except rate limiting shows
  the same generic "Login failed"; the app never says which factor was wrong. A 429 shows "Too many
  attempts, try again in N minutes" from `Retry-After`.
- **Session expiry.** Any 401 on an authenticated request wipes the session (token, query cache) and
  lands on login with "Session expired, please sign in again". A 401 from the login or register
  endpoints is an ordinary failed attempt and does not touch the session.
- **Root routing.** Loading shows a splash; signed out goes to the server screen when no server URL is
  stored, otherwise to login; signed in goes home.

## Home screen

Bottom tabs: Home, Transactions, Connections, Settings (Connections is a placeholder until its
screen lands). The `(app)` layout is also the root gate (splash, onboarding redirect, tabs).

- **Data.** `GET /home?period=current|previous`, switched with a segmented control. Budget cards show
  name, period kind (weekly/monthly), the spent amount large, "of <amount>" and a progress bar. Below:
  the spending breakdown (largest first), an income line, an uncategorised-income line when non-zero,
  and a "some foreign amounts couldn't be converted" note when `fxMissing`.
- **Money.** Displayed from `{minor, currency}` with `Intl.NumberFormat('de-DE')` and the currency
  exponent from `@budgedino/shared`; minor units are split by string arithmetic, never floats.
- **Progress bar.** Fill is clamped to 0 to 100 %. Amber from ratio 0.8, red from 1. A ratio above 1
  shows a full red bar, the amount in red and "Over budget (N %)". Refunds (negative `spent`) show the
  negative amount and an empty bar. A zero budget never divides: no spending shows an empty bar, any
  positive spending a full red bar.
- **Sync status.** One chip per connector in `home.sync` (status and last successful sync, relative).
  A needs-attention chip of the user's own connector opens Connections; other members' chips are inert.
- **Pull-to-refresh.** Calls `POST /connectors/:id/sync` for the user's own connectors with status `ok`
  (`isOwner`), then refetches home. A 429 shows "Already syncing, try again in N s".
- **Offline.** If the server is unreachable the cached data stays visible under an "Offline — showing
  data from <time>" banner with Retry (other failures say "Couldn't refresh"). Without a cache a clear
  offline empty state with Retry is shown. A network failure is retried once, so it never spins long.
- **Accessibility.** Text wraps (no truncation) and the screen scrolls, so it stays usable at font scale 2.
- **Precision note.** Money is formatted by passing an exact decimal string to `Intl.NumberFormat`; a Hermes without Intl v3 coerces it to a Number, which loses precision beyond 2^53 minor units.
- **Period header.** Monthly shows "November 2026", weekly "10–16 Nov" (or "28 Oct – 3 Nov" across months), from `period.start`/`end` (end exclusive) in Europe/Berlin.
- **Sync errors.** A non-429 failure while syncing on pull-to-refresh shows a "Sync failed" snackbar; the refetch still runs.

## Transactions

- **List.** `GET /transactions` with the server's cursor (`limit` 50), loaded as an infinite list on
  end-reached and refreshed by pull-to-refresh. Grouped by booking date; headers read "Today",
  "Yesterday" or "Mon, 9 Nov 2026", with "today" taken in Europe/Berlin. Each row shows counterparty,
  category name (from `GET /categories`; "Split" for split transactions, "Uncategorized" otherwise),
  a "Pending" badge for pending ones and the amount (negative in the neutral text colour, positive green).
  Offline, cached pages stay visible under a banner with Retry.
- **Detail.** Counterparty, purpose, account, booking date, category. Tapping a category sends
  `PATCH /transactions/:id {categoryId}`; the "Always use this for <counterparty>" switch (only shown
  when there is a counterparty) adds `applyToCounterparty: true`. The change is **optimistic** in every
  cached transaction list and **rolls back** on any error (422, network, 5xx) with a snackbar message.
  On success the `home` and `transactions` queries are invalidated (a rule can touch many rows and
  moves budgets). Split transactions are shown read-only. The detail reads the transaction from the
  cached list (there is no single-transaction endpoint).
- **Accessibility.** Rows and fields wrap instead of truncating, so they stay usable at font scale 2.

## Settings > Accounts

Settings lists "Accounts". `GET /accounts` shows every visible account (name, masked IBAN, balance).
Only the user's own accounts (`isOwner`) have the switches "Private (only me)" (`visibility`
`owner_only`/`household`) and "Counts toward budgets". Updates are not optimistic: the server derives
`countsTowardBudgets` from visibility, so the screen shows the account the server returned. Accounts
of other members only read "Shared by another member". A successful update invalidates `home` and
`transactions`.

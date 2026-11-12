# Spec: Mobile app

The Expo Android app (development build, never Expo Go) talks to one self-hosted server.

## Mobile onboarding

- **Server URL.** The user enters the server address; "Check" calls the public `GET /api/v1/health`
  before continuing. The URL is normalised: scheme and host lowercased, trailing slashes and a pasted
  `/api/v1` removed, any other path kept. Only `https://` is accepted; `http://` is accepted only in the
  development variant (`extra.allowCleartext`, read from the Metro env and honoured only when `__DEV__`; the native
  cleartext flag is fixed at prebuild). Release builds reject it.
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
- **Self-hosting link.** Until a server was checked, the server screen offers "No server yet? Host your
  own", opening the GitHub repository's self-hosting docs in the browser.

## Splash screen and app icon

- The native splash (`expo-splash-screen`) shows the BudgeDino mark (a stegosaurus whose back plates
  are gold coins) on the accent green (`#2E7D6B`), or on the dark theme background (`#0E1311`) when the
  device is in dark mode. Assets live in `src/mobile/assets/` (generated PNGs; icon, adaptive icon with
  monochrome layer for themed icons, splash mark).
- The splash stays up until the encrypted cache is open and the session is hydrated, then fades out
  (250 ms). It never stays longer than 5 s, whatever happens during start-up.

## About and versioning

- More > About shows the app version (GitVersion SemVer of the build's commit), the build number
  (Android `versionCode`), the short commit SHA (opens the commit on GitHub) and the server version
  (`GET /health`; "Checking…", "Unreachable" or "Not connected").
- Links (open in the browser): source code (`github.com/nmehlei/BudgeDino`), report a problem (GitHub
  issues), self-hosting docs, license (AGPL-3.0). Settings > Server links the self-hosting docs too.
- Versions: [ADR 0010](../adr/0010-gitversion-mainline.md). Every commit gets its own version; the server
  reports the same scheme from `/health`.

## Home screen

Bottom tabs: Home, Transactions, Connections, More. The `(app)` layout is also the root gate (splash, onboarding redirect, tabs).

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
- **Sync status.** One chip per connector in `home.sync` (status and last successful sync, relative), labelled with the
  connection's `displayName` (own connections) or the bank name ("Demo bank" for `fake`), never the raw type.
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

Settings (More > Settings) lists "Accounts". `GET /accounts` shows every visible account (name, masked IBAN, balance).
Only the user's own accounts (`isOwner`) have the switches "Private (only me)" (`visibility`
`owner_only`/`household`) and "Counts toward budgets". Updates are not optimistic: the server derives
`countsTowardBudgets` from visibility, so the screen shows the account the server returned. Accounts
of other members only read "Shared by another member". A successful update invalidates `home` and
`transactions`.

## Connections and bank challenges

- **List.** `GET /connectors`, shown as a Paper `List.Item` list with dividers (own connections first, then "Shared by
  others"). Left: the bank avatar. Title: the connection's `displayName` (own connections only), else the bank name
  (`bank` id: DKB, Comdirect, "Demo bank" for `fake`). Description: status and last sync (relative), plus the consent
  expiry. Right: a status indicator (icon plus colour, with an accessibility label) and, for own connections, a 3-dot
  `IconButton` that opens a Paper `Menu`. Other members' connections have no menu and read "Shared by another member".
  Rows grow with the text (no truncation), so they stay usable at font scale 2. Pull-to-refresh is kept.
- **Avatar fallback chain [call].** (1) The bank icon `GET /banks/:bank/icon`, loaded by an `Image` whose request carries the
  session token as a header (read fresh from the store when the avatar mounts; the token is never put in the query
  cache); (2) when that fails or the bank has no icon, a monogram `Avatar.Text` with the bank initials in the bank's brand
  colours (unknown banks use the theme's primary container); (3) when there is no usable name, an `Avatar.Icon` `bank`.
  Brand colours are used only for the monogram; everything else uses theme colours.
- **Menu actions.** "Sync now" for status `ok` and `error` (`POST /connectors/:id/sync`; a user run may restore an errored
  connector), "Reconnect" for `needs_attention` and `error` (`POST /connectors/:id/reconnect`), always "Rename" and
  "Delete". `disabled` connections only offer Rename and Delete. Sync and reconnect are user-present: the server never
  starts a bank dialog on its own.
- **Add bank.** A Paper extended `FAB` "Add bank" at the bottom right, above the tab bar and the safe-area inset,
  opens the add screen. There is no other add button.
- **Rename.** A dialog with a text input (max 60 characters) prefilled with the current name; Save sends
  `PATCH /connectors/:id {displayName}` (an empty input clears the name). The list is refetched.
- **Delete.** A dialog with two full-width choices: "Remove connection, keep history" (`DELETE /connectors/:id?mode=keep`,
  accounts and transactions stay and keep counting) and "Delete connection and all its data" (destructive styling; asks a
  second confirmation before sending `mode=purge`). The keep choice says that connecting the bank again reuses the kept
  accounts without duplicates. While a removal runs, dismissing the dialog (backdrop, back) is ignored. Both invalidate `connectors`, `home`, `transactions`, `accounts`
  and `net-worth`.
- **Add bank.** DKB or Comdirect (static list matching the server catalog), user id and PIN, and "Keep these
  accounts private" (`accountDefaults.visibility: owner_only`), sent as `POST /connectors {type:'fints', config:{bank,userId,pin}}`.
  "Demo bank" (`type:'fake'`) appears only if `GET /connectors/types` lists `fake`. The PIN field is secure text
  entry with autofill, autocorrect and the context menu off. User id and PIN live only in component state: the
  request is made directly (not through a mutation, so nothing is kept in React Query), and both fields are cleared
  before the request is awaited, also when it fails. They are never logged or stored.
- **Challenge hand-off.** The challenge payload (message, photoTAN image) is kept in an in-memory store, not the
  query cache or MMKV. If it is missing (app restarted), `GET /challenges/:id` decides: a finished challenge shows its
  outcome, an open one offers "Cancel request".
- **decoupled.** Message, spinner and "I've confirmed in my banking app". Polls `POST /challenges/:id/answer
{kind:'decoupled'}` every `pollAfterMs`, at least 2 s; a 429 waits `Retry-After` (also after returning from
  the background). Polling stops while the app is backgrounded (the user is in the bank's app) and resumes on return
  as soon as the schedule allows. A timer on `expiresAt` checks `GET /challenges/:id` and shows the expired state; it
  also fires right after returning from the background if the challenge lapsed meanwhile.
- **code / image.** Numeric input and submit (`{kind:'code'|'image', code}`); a 400/422 shows "Invalid input" and
  keeps the screen; the entered code is cleared after each submit. The image is a `data:` URI from `mimeType` and
  `imageBase64`, tap to enlarge. **redirect** is not used by FinTS and renders "Not supported yet" with Cancel.
- **Outcome.** `completed` shows a success screen then Connections (connectors, home, accounts and transactions are
  refetched). `expired`/`cancelled` show the reason (`declined`, `too_many_invalid_answers`) and "Try again", which
  reconnects. Cancel calls `DELETE /challenges/:id`.
- **Accessibility.** The screen scrolls and buttons wrap (Paper's Button truncates labels to one line, so the
  challenge screen uses its own wrapping button), so it stays usable at font scale 2.

## Budgets

More has a "Budgets" entry (`piggy-bank-outline`, above Settings) that opens `more/budgets`. `GET /budgets`
([budgets.md](budgets.md)). Editing is admin-only (as the routes are); members see a read-only list.

- **List.** Each row shows the name, the period (Weekly/Monthly) and the budget amount. Admins get a "New budget"
  FAB, tap a row to edit it and a delete icon with a confirm dialog (`DELETE /budgets/:id` archives). Members get no
  FAB, no edit and no delete, plus the note "Only admins can change budgets". Load errors show a Retry.
- **Admin check.** `useIsAdmin()` (`household/queries.ts`) reads the caller's row (`isSelf`) of
  `GET /households/members`. It is `false` while unknown or when the lookup fails (e.g. 403), so the app falls back
  to the read-only view and never surfaces a crash.
- **Form** (`more/budgets/new`, `more/budgets/[id]`). Name (1-80), category chips (multi-select, at least one),
  period (weekly/monthly) and amount. Only active spending categories are offered (no income, transfer or archived
  ones); an archived category an existing budget still uses stays visible as an "(archived)" chip. `useCategories()`
  (`budgets/queries.ts`) hides archived categories by default and is reused by other screens.
- **Amount input.** German style, `.` thousands and `,` decimal (`1.234,56`, `12,5`, `500`). Only positive amounts
  with at most the currency's decimals (`currencyExponent`) parse; anything else shows a field error and nothing is
  sent. Parsing is string/bigint only (`parseMoneyInput`); the body carries `amount: { minor: '<digits>', currency }`.
  The currency is that of the existing budgets, `EUR` when there are none.
- **After a change** the `budgets` and `home` queries are invalidated; a 403 reads "Only admins can change budgets.".

## Household and join link

More has a "Household" entry (`account-group-outline`, after Budgets, above Settings) that opens `more/household`.

- **Members.** `GET /households/members` lists every member with role and a "You" marker (plus "Disabled" and,
  for admins, the email). If the lookup fails (network, 5xx) the screen shows an error with Retry instead of
  silently falling back to the member view; `useIsAdmin()` (budgets) keeps its "false when unknown" behaviour.
- **Members see** the list and the note "Only admins can invite people"; no invite action, no invites request.
- **Admins** also get "Invite someone" and "Pending invites" (`GET /households/invites`: role and expiry, never a
  token) with a revoke action per row (`DELETE /households/invites/:id`). A 409 shows "This invite was already
  used" and, like every revoke outcome, refetches the list (and the members, since a used invite is a new member);
  404 reads "This invite no longer exists".
- **Invite sheet.** Role picker (member/admin), then `POST /households/invites`. The result is shown as a QR
  code and shared via the system share sheet. Both carry the join link
  `budgedino://register?server=<serverUrl>&invite=<token>` (`buildJoinLink`, both values URL-encoded; the server
  is the app's configured server URL). The token lives only in the sheet's component state: the call bypasses
  `useMutation` so it never enters the TanStack Query cache, it is never persisted (MMKV, SecureStore) or logged,
  and it is dropped when the sheet closes (the sheet is unmounted). The sheet says the code is shown only once.
- **Register via join link.** `register` reads `server` and `invite` from the route params. The invite prefills
  the token field. The server goes through `validateServerUrl` (https only unless the development variant allows
  cleartext) and is held in component state only: opening a link never changes the stored server. A valid server
  shows "Joining a household on <host>" above the form, so a link with a foreign host is visible before a password
  is typed. On Continue the app first runs the same `health()` check as the server screen against the link's
  server and registers against it. Only after registration succeeded is the server stored as the session server
  (before opening the TOTP step, which reads it); any failure (health, invite, network) stores nothing. While signed in, the link is refused ("Sign out first to join another household.") and the session is
  untouched, since changing the server would send the session token elsewhere. A rejected server shows the usual
  validation message, stores nothing and shows no banner. Without link params nothing changes.
- **Invite sheet and revoke.** The sheet scrolls (font scale 2); revoking an invite asks for confirmation first.

## Net worth

More has a "Net worth" entry (`chart-line`) that opens `more/net-worth`. `GET /net-worth` ([net-worth.md](net-worth.md)).

- **Layout.** A large total in the base currency, then the accounts grouped by kind (Checking, Savings, Credit cards,
  Depots, Other) with the group total. Each account shows its name and balance; when its currency differs from the base
  currency the converted value is shown too. An account without a balance reads "No balance yet"; one whose connection was
  removed reads "Disconnected". A "some foreign amounts couldn't be converted" note appears when `fxMissing`.
- **States.** Pull-to-refresh refetches. Offline, the cached data stays under an "Offline - showing data from <time>" banner
  with Retry (other failures say "Couldn't refresh"); without a cache an offline empty state with Retry. No accounts: the
  empty state "Connect a bank to see your net worth". A small "History graph coming soon" hint marks P5.
- **Accessibility.** Text wraps and the screen scrolls, so it stays usable at font scale 2.

## Notifications, app lock and screen protection

- **Notifications are local only** (no FCM, no Expo push). One function, `pollNotifications`, serves both the
  background task `budgedino-notifications` (expo-background-task, minimum interval 15 min) and the foreground
  poll (on entering the signed-in app and on every return to the foreground). It fetches `GET /notifications`,
  shows one local notification per item (title "BudgeDino", body = the server's body, Android channel "Budget &
  connections", lock-screen visibility private; the server id is the notification identifier, so a re-delivery
  replaces rather than duplicates), then `POST /notifications/ack` with exactly the ids that were shown. An
  in-flight guard makes a second call join the running poll, so nothing is shown or acked twice. Signed out
  (no server URL or token) it does nothing; a 401 signs the user out like everywhere else. Bodies are never
  logged. The app asks for `POST_NOTIFICATIONS` once (Settings shows an "Allow" row while it is undecided).
- **App lock** wraps the authenticated tree only. On a cold start (not right after a password sign-in in this
  process) and after more than 60 s in the background it requires biometric authentication with the device
  credential as fallback (`authenticateAsync`). Failure or cancel keeps the app locked with an "Unlock" button and a "Sign out" escape (wipes everything, so a broken biometric can never lock the user out for good). When the app goes to the background an opaque cover appears at once (no prompt) so the recents/resume frame never shows content; a return within 60 s removes it, later (or after the clock was set back) locks;
  children are not mounted before the first unlock and are hidden while re-locked. If the device has neither a
  biometric nor a screen lock enrolled (`getEnrolledLevelAsync` is `NONE`), a one-time notice explains that the
  app lock needs a screen lock and the user is let in. The preference "App lock" (default on) is stored in MMKV
  prefs; turning it off requires passing the lock once (authentication is skipped only when the device has no screen lock).
- **Screen protection.** Authenticated screens call `preventScreenCaptureAsync`, so screenshots and the recents
  thumbnail are blocked; the login screens are not protected, except the TOTP setup screen (it shows the
  provisioning secret), which is.
- **Session-expired notice.** `expireSession` (also from the headless background task) persists an
  `expiredNotice` flag in the MMKV prefs; the login screen shows "Session expired, please sign in again" once and
  clears it. A user sign-out never sets it. Sign-out also clears the in-memory challenge and pending-registration
  hand-overs.
- **More and Settings.** The last tab, More, is a list with one entry, Settings (room for more later). Routes: `/more`, `/more/settings`, and under it `appearance`, `security`, `devices`, `accounts`, `server`; each has a back header and wraps at font scale 2. Settings lists Appearance, Security, Devices, Accounts, Server and, at the bottom, Sign out (with confirmation). **Security** holds the lock toggle and the notification permission row. **Devices** lists signed-in devices (`GET /auth/sessions`; "Sign out" on
  another device calls `DELETE /auth/sessions/:id`). **Server** shows the server URL. On sign-out the periodic background task is unregistered and delivered notifications are dismissed (best effort). A signed-out start (hydrate finds no session) wipes the persisted cache and the query client before anything renders, so data left behind by an earlier session is never shown to the next user. Sign out first revokes this
  device's session on the server (best effort; network errors are ignored), then wipes the token, the MMKV cache
  and the query cache through the session store. A 401 sign-out stays local.

**Demo bank config.** "Demo bank" sends `{ type: 'fake', config: { scenario: 'decoupled' } }`: connecting
returns a `decoupled` challenge that the user confirms on the challenge screen (this also drives the Maestro
flow `connect-demo-bank.yaml`). Dev loop and seed: [self-hosting.md](self-hosting.md#local-development-loop-implemented).

## Appearance

- Settings > Appearance offers System / Light / Dark (radio list, wraps at large font
  scales). Default: System, which follows the OS colour scheme.
- The choice is stored in the non-secret MMKV prefs (`budgedino-prefs`, key `themePreference`; absent
  means System) and applies immediately, no restart. It survives sign-out.
- One resolved theme drives everything: Paper, the React Navigation theme (screens, tab bar, headers,
  derived from the Paper theme via `ThemeProvider`), the status bar (light icons on dark), pull-to-refresh
  colours, the auth screens and the lock cover. Warning/success colours follow it too.
- `Appearance.setColorScheme('light' | 'dark' | 'auto')` is called on every change and at start, so
  native parts (keyboard, dialogs) match; System maps to `'auto'`.
- Dark palette: near-black green-tinted background, slightly lighter surfaces and cards, one accent;
  text/background contrast is at least 7:1.
- Text colours are always explicit theme colours: never `color: undefined` in a style (it overrides
  Paper's colour with the native default, black on Android).
- The Android app theme opts out of OS force-dark (`android:forceDarkAllowed=false`, config plugin
  `plugins/with-no-force-dark.js`, applied on every prebuild), so Samsung One UI cannot recolour the app.

# P3 — Android App Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An Expo (development build, not Expo Go) Android app that the owner can install on a physical Samsung S22 over USB and use against a locally running BudgeDino server: onboarding (server URL, invite registration with TOTP, login), home screen with budgets and spending breakdown, transactions with recategorization, bank connections with typed challenges (DKB app confirmation, TAN code, photoTAN), notification polling, app lock and an encrypted cache.

**Architecture:** `src/mobile` is an Expo app (expo-router, TypeScript strict) consuming the server's `/api/v1` through a typed client that validates every response with the zod schemas from `@budgedino/shared`. Server state lives in TanStack Query with a persisted cache encrypted by a key kept in the Android Keystore (expo-secure-store). UI uses React Native Paper (Material 3) with a small theme of its own. Notifications are local only: a background task polls the server (no push service, per spec).

**Tech Stack:** Expo SDK 58 (latest stable at implementation time), React Native, expo-router, react-native-paper, @tanstack/react-query (+ persist), react-native-mmkv (encrypted), expo-secure-store, expo-local-authentication, expo-screen-capture, expo-notifications, expo-background-task, expo-camera not needed, react-native-qrcode-svg, jest-expo + @testing-library/react-native, Maestro (device flows, not CI). JDK 21 pinned per project via `.mise.toml`.

**Spec:** `docs/specs/2026-11-08-budgedino-design.md` §4 screens; `docs/specs/household-and-access.md`, `sync-and-connectors.md`, `budgets.md`, `security.md`; API: `docs/api/openapi.json`.

## Global Constraints

- Expo **development build** (`expo run:android` / `expo-dev-client`), never Expo Go. Android only for now; nothing may prevent iOS later.
- **Never start an Android emulator.** Device runs target the owner's physical S22 over USB (`adb devices`), or the device farm; tests that need a device are opt-in and never in CI.
- Every API response is parsed with the shared zod schema; schema mismatch → typed error, never `any`.
- Session token only in expo-secure-store; never in MMKV, logs, crash output or React state dumps.
- Cached data (query cache) only in MMKV with encryption key from expo-secure-store (Keystore-backed).
- App lock: biometric/device credential on cold start and after 60 s in background. Screens excluded from recents screenshots (`preventScreenCaptureAsync`).
- Notifications: local only; content fetched from the server; no FCM/Expo push.
- Money displayed from `{minor, currency}` via `Intl.NumberFormat('de-DE', …)` with currency exponent from `@budgedino/shared` `currencyExponent`; never floats in logic (formatting may divide only inside the formatter via string arithmetic).
- Cleartext HTTP allowed **only in debug builds** (LAN dev server); release builds require HTTPS.
- Package id `app.budgedino` (call — change before first Play release if wanted); app name "BudgeDino".
- Calm default visual design: light/dark from system, one accent colour, generous spacing, large numbers for budgets; no custom fonts.
- No AI attribution in commits/docs.

## Review Focus

1. **Server unreachable / phone on mobile data** (common with a LAN dev server): every screen shows a clear offline state with cached data and a retry, never a spinner forever or a crash. → Task 2, Task 4.
2. **Session expired/revoked** (P1: 90-day idle, 365-day absolute, revoke from another device): any 401 → token wiped, cache wiped, back to login with a message. → Task 2.
3. **App backgrounded during a decoupled challenge** (user switches to the DKB app to confirm): polling resumes on return, respects `pollAfterMs` and 429 Retry-After, and the challenge completes or shows expiry. → Task 6.
4. **Large/negative/foreign amounts and zero budgets**: `-1234567.89 EUR`, `JPY`, refunds making spent negative, ratio > 1 → formatting and progress bars stay correct (bar clamps 0–100 %, over-budget shown red with amount). → Task 4.
5. **Rotation and system font scaling 200 %**: home and challenge screens remain usable (no clipped TAN input/buttons). → Task 4/6 component tests with large font scale.

---

### Task 1: Expo app scaffold in the monorepo

**Files:**

- Create: `src/mobile/` (Expo app via `create-expo-app` template `default` → trimmed), `src/mobile/app.config.ts`, `src/mobile/app/_layout.tsx`, `src/mobile/src/theme.ts`, `src/mobile/tsconfig.json`, `src/mobile/jest.config.js`, `src/mobile/eslint` integration, `.mise.toml` (`java = "21"`)
- Modify: `pnpm-workspace.yaml` (if needed), root `package.json` scripts, `ci/check.sh`, `AGENTS.md`, `README.md`
- Test: `src/mobile/src/__tests__/smoke.test.tsx`

**Interfaces:**

- Root scripts: `pnpm mobile:test` (jest), `pnpm mobile:lint`, `pnpm mobile:typecheck`, `pnpm mobile:android` (`expo run:android --device`, picks the attached S22; documented), `pnpm mobile:prebuild`.
- `app.config.ts`: name BudgeDino, slug budgedino, `android.package = 'app.budgedino'`, plugins for secure-store, local-authentication, notifications, background-task; `usesCleartextTraffic` only when `APP_VARIANT=development`.
- `theme.ts`: Paper MD3 light/dark themes from one accent (`#2E7D6B`), exported `useAppTheme()`.

- [ ] **Step 1:** Smoke test renders the root layout with providers (Paper, QueryClient) and shows "BudgeDino".
- [ ] **Step 2–4:** RED → scaffold (pnpm + Metro monorepo config: `watchFolders` root, `nodeModulesPaths`, resolve `@budgedino/shared` from source) → GREEN; `pnpm mobile:typecheck`, `pnpm mobile:lint` green; `npx expo prebuild --platform android --no-install` succeeds (do not commit `android/` — add to .gitignore; CNG).
- [ ] **Step 5:** Add mobile lint/typecheck/test to `ci/check.sh` (no Android build in CI). Commit `feat(mobile): expo app scaffold`.

### Task 2: Typed API client, session and connectivity

**Files:**

- Create: `src/mobile/src/api/client.ts`, `src/mobile/src/api/errors.ts`, `src/mobile/src/session/session-store.ts`, `src/mobile/src/session/useSession.ts`, `src/mobile/src/cache/secure-cache.ts`
- Test: `src/mobile/src/api/__tests__/client.test.ts`, `src/mobile/src/session/__tests__/session.test.ts`

**Interfaces:**

- `createApiClient({ baseUrl, getToken, onUnauthorized, fetchImpl? })` → methods mirroring server routes used by the app, each `(input) => Promise<Output>` with zod parse of the response schema from `@budgedino/shared/api` (auth, households, accounts, connectors, challenges, transactions, budgets, home, notifications).
- `ApiError` union: `{kind:'network'} | {kind:'unauthorized'} | {kind:'rate_limited', retryAfterSec} | {kind:'validation', issues} | {kind:'server', status} | {kind:'schema_mismatch'}`.
- Session store: server URL + device name in MMKV (non-secret), token in SecureStore; `signOut()` wipes token, query cache and MMKV cache store.
- `secure-cache.ts`: MMKV instance `budgedino-cache` with `encryptionKey` = 32 random bytes generated once and stored in SecureStore (`requireAuthentication: false`, `keychainAccessible: WHEN_UNLOCKED_THIS_DEVICE_ONLY`); TanStack `createSyncStoragePersister` on top; `maxAge` 7 days.
- [ ] **Step 1:** Tests (mock fetch): Bearer header sent; 401 → onUnauthorized + `unauthorized` error; 429 parses Retry-After; network failure → `network`; response failing schema → `schema_mismatch` (never returns unparsed data); signOut wipes token+cache (mock SecureStore/MMKV).
- [ ] **Step 2–5:** RED → implement → GREEN → commit `feat(mobile): typed api client and session`.

### Task 3: Onboarding — server URL, invite registration with TOTP, login

**Files:**

- Create: `src/mobile/app/(auth)/server.tsx`, `register.tsx`, `register-totp.tsx`, `login.tsx`, `src/mobile/src/auth/*`
- Test: `src/mobile/app/(auth)/__tests__/*.test.tsx`

**Behaviour:**

- Server screen: URL input (normalises trailing slash, requires `https://` except `http://` allowed in development variant), "Check" calls a public endpoint (add `GET /api/v1/health` → `{ok:true, version}` to the server if none exists, `access:'public'`, with a route-fixtures entry if needed) before continuing.
- Register: invite token (paste), email, display name, password (min 12, show strength hint), device name prefilled from device model → `POST /auth/register` → TOTP screen shows QR (react-native-qrcode-svg of `totpProvisioningUri`) and a "copy secret" fallback (secret parsed from the URI, shown monospaced, copy to clipboard) → 6-digit code → `/auth/register/confirm` → token stored.
- Login: email, password, TOTP code → token. Server errors shown generically ("Login failed") — never which factor failed; 429 shows "Too many attempts, try again in N minutes".
- [ ] **Step 1:** Component tests with mocked client: happy register path stores token and navigates to home; login 401 shows generic message; 429 shows retry minutes; http URL rejected in production variant; TOTP code field accepts only 6 digits.
- [ ] **Step 2–5:** RED → implement (+ server health route with its own server test) → GREEN → commit `feat(mobile): onboarding with invite, TOTP and login`.

### Task 4: Home screen

**Files:**

- Create: `src/mobile/app/(app)/_layout.tsx` (bottom tabs: Home, Transactions, Connections, Settings), `src/mobile/app/(app)/index.tsx`, `src/mobile/src/home/*` (BudgetCard, BreakdownList, SyncStatusBar, PeriodSwitcher), `src/mobile/src/format/money.ts`
- Test: `src/mobile/src/format/__tests__/money.test.ts`, `src/mobile/src/home/__tests__/*.test.tsx`

**Behaviour:**

- `GET /home?period=current|previous` — period switcher; budget cards: name, `spent / amount`, progress bar (clamp 0–100 %, red when ratio ≥ 1, amber ≥ 0.8), per-budget period label (weekly/monthly); `fxMissing` → small "some foreign amounts couldn't be converted" note.
- Breakdown list sorted desc with category name and amount; separate income/uncategorizedIncome line.
- Sync status bar: per connector status chip (ok / needs attention → tap to Connections / error), last sync relative time; pull-to-refresh triggers `POST /connectors/:id/sync` for own ok connectors (429 → toast "already syncing / try again in Ns") then refetches home.
- Offline: cached data shown with "Offline — showing data from <time>" banner and retry.
- `formatMoney({minor,currency})` uses `currencyExponent` and BigInt-safe string formatting into `Intl.NumberFormat('de-DE', {style:'currency', currency})`.
- [ ] **Step 1:** Tests: formatMoney for `-123456789n EUR` → `-1.234.567,89 €`, `100n JPY` → `100 ¥`, `0n` → `0,00 €`; BudgetCard ratio 1.25 → bar 100 % + over-budget style; offline banner when the client throws network and cache exists; render at fontScale 2 (RNTL + `PixelRatio`/`Text` allowFontScaling) without overflow assertions failing (use `numberOfLines`/wrapping checks).
- [ ] **Step 2–5:** RED → implement → GREEN → commit `feat(mobile): home screen with budgets and breakdown`.

### Task 5: Transactions, recategorization, accounts

**Files:**

- Create: `src/mobile/app/(app)/transactions.tsx`, `src/mobile/app/(app)/transaction/[id].tsx`, `src/mobile/app/(app)/settings/accounts.tsx`, `src/mobile/src/transactions/*`
- Test: corresponding `__tests__`

**Behaviour:**

- Infinite list (`GET /transactions` cursor), grouped by booking date, pending badge, amount coloured (negative neutral, positive green).
- Detail: counterparty, purpose, account, category; category picker (categories come from… there is no categories endpoint yet → add `GET /api/v1/categories` (member) on the server returning household categories, with route fixture + test) ; "Always use this for <counterparty>" toggle → `PATCH /transactions/:id {categoryId, applyToCounterparty}`; optimistic update with rollback on error.
- Settings → Accounts: list own + visible accounts; for own accounts toggles "Private (only me)" and "Counts toward budgets" → `PATCH /accounts/:id`.
- [ ] **Step 1:** Tests: list paginates; recategorize optimistic + rollback on 422; private toggle sends visibility and reflects server's countsTowardBudgets; non-owned accounts show no toggles. Server: categories route test (member sees own household's, not other's).
- [ ] **Step 2–5:** RED → implement → GREEN → commit `feat(mobile): transactions, recategorization and account settings`.

### Task 6: Connections and bank challenges

**Files:**

- Create: `src/mobile/app/(app)/connections/index.tsx`, `add.tsx`, `challenge/[id].tsx`, `src/mobile/src/connections/*`
- Test: `__tests__` incl. `challenge.test.tsx`

**Behaviour:**

- List: own connectors (type/bank, status, last sync, consent expiry), "Sync now", "Reconnect" (for needs_attention/error), others' connectors read-only.
- Add bank: choose DKB or Comdirect (from a static list matching the server catalog) → user id + PIN (secure text entry, no autofill to clipboard) + "Keep these accounts private" switch (→ `accountDefaults`) → `POST /connectors {type:'fints', config, accountDefaults}`. Also "Demo bank" (`type:'fake'`) shown only when the server reports it (add `GET /api/v1/connectors/types` → enabled connector types; route fixture + test).
- Challenge screen by kind: `decoupled` — message + spinner + "I've confirmed in my banking app" button; auto-poll every `pollAfterMs` (min 2 s) via `POST /challenges/:id/answer {kind:'decoupled'}`; respects 429 Retry-After; pauses in background (AppState) and resumes on return. `code` — message + numeric input + submit; 422 shows "Invalid input" and keeps the screen. `image` — `data:` URI from `mimeType`+`imageBase64` shown large (zoomable) + code input. `redirect` — not supported by fints; render "unsupported" gracefully. Status `completed` → success screen → Connections; `expired`/`cancelled` → message + "Try again" (reconnect). Cancel button → `DELETE /challenges/:id`.
- PIN is cleared from component state immediately after the request is sent.
- [ ] **Step 1:** Tests (fake timers + mocked client): decoupled polls at pollAfterMs, honours Retry-After, pauses on background and resumes; code 422 keeps screen; image renders data URI with correct mime; completed navigates; expired offers retry; PIN field value not retained after submit; private switch sends accountDefaults.
- [ ] **Step 2–5:** RED → implement (+ server connectors/types route with test) → GREEN → commit `feat(mobile): bank connections and challenge flows`.

### Task 7: Notifications, app lock, screen protection

**Files:**

- Create: `src/mobile/src/notifications/poll-task.ts`, `src/mobile/src/notifications/useNotificationPermission.ts`, `src/mobile/src/security/AppLock.tsx`, `src/mobile/src/security/useScreenProtection.ts`, `src/mobile/app/(app)/settings/index.tsx`
- Test: `__tests__` for each

**Behaviour:**

- Background task `budgedino-notifications` (expo-background-task, minimum interval 15 min): if signed in, `GET /notifications`, schedule a local notification per item (title "BudgeDino", body = server body), then `POST /notifications/ack`; also runs on app foreground. Android channel "Budget & connections".
- App lock: on cold start and when returning after > 60 s, require `authenticateAsync` (biometric or device credential fallback); failure → stays locked; setting to disable lock (default on).
- Screen protection on all authenticated screens; Settings: sign out (wipes everything), server URL display, lock toggle, devices list (`GET /auth/sessions`, revoke others).
- [ ] **Step 1:** Tests: poll task schedules one local notification per item and acks exactly those ids; no-op when signed out; 401 inside the task signs out; AppLock gates children until success and re-locks after 60 s background (fake timers + AppState mock); sign-out wipes SecureStore token + MMKV + query cache.
- [ ] **Step 2–5:** RED → implement → GREEN → commit `feat(mobile): notification polling, app lock, screen protection`.

### Task 8: Local dev loop on the S22, demo seed, Maestro flows

**Files:**

- Create: `docker-compose.dev.yml` (postgres only, port 5433), `src/server/src/dev/seed.ts` + CLI `budgedino dev-seed` (refuses when `NODE_ENV=production`), `docs/guides/run-on-android-device.md`, `src/mobile/maestro/{login,home,connect-demo-bank}.yaml`
- Modify: root scripts (`pnpm dev:db`, `pnpm dev:server` with fake connector enabled and HOST=0.0.0.0, `pnpm mobile:android`, `pnpm maestro:device`), README, AGENTS.md
- Test: `tests/server/dev/seed.int.test.ts`

**Behaviour:**

- `dev-seed` creates (idempotently) a demo household, prints a one-time admin invite, and a FakeConnector config template the app's "Demo bank" uses; with `--with-data` it also creates a connected fake connector with ~60 days of realistic German transactions (REWE, EDEKA, DB, Netflix, salary) and two budgets (Groceries 500 € monthly, Eating out 60 € weekly) so the home screen shows real numbers.
- Guide `run-on-android-device.md` (checklist style): USB debugging on the S22, `adb devices` shows it, `.mise.toml` Java 21, `pnpm dev:db`, `pnpm dev:server`, find Mac LAN IP, `pnpm mobile:android` (first build 5–10 min), enter `http://<lan-ip>:8080` in the app, register with the seed invite, add TOTP to an authenticator, see the demo data; troubleshooting (firewall on port 8080, device unauthorized, Metro on same Wi-Fi).
- Maestro flows (opt-in, physical device or device farm; never CI): login with seeded user (TOTP via a test-only `BUDGEDINO_DEV_TOTP_SECRET` printed by the seed), home shows "Groceries", connect demo bank with decoupled challenge completes.
- [ ] **Step 1:** Seed integration test: idempotent; refuses in production; `--with-data` produces home numbers (call buildApp `/home` as the seeded admin).
- [ ] **Step 2–5:** RED → implement → GREEN; full `bash ci/check.sh` green; commit `feat: local device dev loop, demo seed, maestro flows`.

---

## Owner steps (outside CI)

- Connect the S22 via USB with USB debugging enabled, then follow `docs/guides/run-on-android-device.md`.
- Optional: run the Maestro flows on the S22 (`pnpm maestro:device`).

# P2 — FinTS Connector (DKB, Comdirect) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A real `fints` connector that authenticates against DKB and Comdirect with PIN/TAN (decoupled app confirmation, pushTAN/SMS codes, photoTAN), lists accounts and syncs checking, savings and credit-card transactions through the P1 sync engine.

**Architecture:** The connector implements the P1 `Connector` interface (`src/server/src/connectors/types.ts`). All bank I/O goes through a narrow `FinTSPort` seam: production uses `lib-fints` (`LibFintsPort`), tests use a scripted fake (`ScriptedFinTSPort`). lib-fints keeps an open TAN dialog inside its client object (not serialisable), so live clients are held in an in-process `FinTSDialogRegistry` keyed by a random handle stored in `DialogState`; a lost handle (restart, TTL) ends the challenge cleanly.

**Tech Stack:** `lib-fints` 1.5.x (LGPL-2.1-or-later, used unmodified as a dependency), existing P1 stack.

**Spec:** `docs/specs/sync-and-connectors.md`, `docs/specs/security.md`, `docs/specs/self-hosting.md` (founding design: `docs/specs/2026-11-08-budgedino-design.md`).

## Global Constraints

- Read-only bank access; never call any payment/transfer method of lib-fints.
- The server never starts an interactive bank dialog on its own; a TAN needed during an unattended or sync fetch → `{ok:false, reason:'needs_attention'}`, never a thrown error.
- FinTS default schedule: every 4 hours (`defaultSchedule: { cron: '0 */4 * * *' }`), `maxUnattendedPerDay: null`.
- Money: integer minor units; lib-fints returns JS numbers → convert via decimal string, never `Math.round(x*100)` on raw floats without fixing to 2 decimals first.
- PIN, user id, banking information (BPD/UPD), system id live only in encrypted `config_enc` / `state_enc`; never in logs, errors, dialog responses or challenge payloads.
- FinTS product registration id comes from operator config `BUDGEDINO_FINTS_PRODUCT_ID` (+ `BUDGEDINO_FINTS_PRODUCT_VERSION`, default `1.0`); without it the `fints` connector is not registered.
- Single server instance (P1 assumption); in-memory dialogs are acceptable and documented.
- Live bank tests are opt-in via env and never run in CI.
- No AI attribution in commits/docs.

## Review Focus

1. **Float amounts:** `-0.1 + -0.2`-style artefacts and amounts like `1234.5` / `-0.07` must map exactly to `-30n`, `123450n`, `-7n`. → Task 1 tests.
2. **Dates as JS `Date`:** lib-fints builds dates at local midnight; converting with UTC getters on a non-UTC host shifts the day. Mapping must use the same (local) getters lib-fints used; test with `TZ=Pacific/Kiritimati` and `TZ=America/Los_Angeles` runs. → Task 1.
3. **TAN required during a scheduled fetch** (PSD2 90-day SCA renewal): must yield `needs_attention`, keep state, notify — never throw/hang. → Task 5.
4. **Server restart between "TAN challenge issued" and "user confirms":** continuing must fail with `ConnectorAuthError('timeout')` (challenge expired), never crash or reuse a wrong client. → Task 3/4.
5. **Accounts sharing an account number** (depot and its settlement account): refs must be unique and stable (`iban` if present, else `number:subAccount:blz`). → Task 5.

---

### Task 1: lib-fints seam and pure mapping

**Files:**

- Create: `src/server/src/connectors/fints/port.ts`, `src/server/src/connectors/fints/map.ts`
- Test: `tests/server/connectors/fints/map.test.ts`

**Interfaces:**

- Produces (`port.ts`) — the only surface the connector uses:
  ```ts
  interface FinTSPortResponse {
    success: boolean;
    requiresTan: boolean;
    tanReference?: string;
    tanChallenge?: string;
    tanPhoto?: { mimeType: string; data: Uint8Array };
    bankAnswers: { code: number; text: string }[];
    bankingInformationUpdated: boolean;
  }
  interface FinTSSession {
    synchronize(): Promise<FinTSPortResponse & { bankingInformation?: unknown }>;
    synchronizeWithTan(
      ref: string,
      tan?: string,
    ): Promise<FinTSPortResponse & { bankingInformation?: unknown }>;
    selectTanMethod(id: number): void;
    availableTanMethods(): FinTSTanMethod[]; // {id,name,decoupled:boolean, kind:'decoupled'|'code'|'photo'|'chiptan-optical'}
    accounts(): FinTSAccount[]; // from UPD
    getStatements(
      acc: FinTSAccount,
      from?: Date,
      to?: Date,
    ): Promise<FinTSPortResponse & { transactions?: FinTSTx[] }>;
    getStatementsWithTan(
      ref: string,
      tan?: string,
    ): Promise<FinTSPortResponse & { transactions?: FinTSTx[] }>;
    getCreditCardStatements(
      acc: FinTSAccount,
      from?: Date,
    ): Promise<FinTSPortResponse & { transactions?: FinTSTx[] }>;
    getBalance(
      acc: FinTSAccount,
    ): Promise<FinTSPortResponse & { balance?: { value: number; currency: string } }>;
    bankingInformation(): unknown; // JSON-serialisable snapshot for ConnectorState
  }
  interface FinTSPort {
    openFirstTime(p: FinTSBankParams): FinTSSession;
    openFromState(
      p: FinTSBankParams,
      bankingInformation: unknown,
      tanMethodId: number,
    ): FinTSSession;
  }
  type FinTSBankParams = {
    productId: string;
    productVersion: string;
    url: string;
    blz: string;
    userId: string;
    pin: string;
  };
  ```
  `FinTSAccount` and `FinTSTx` are plain projections of lib-fints `BankAccount` / `Transaction` (+ credit-card statement entries) with the fields the mapper needs.
- Produces (`map.ts`): `toMinor(amount: number, currency: string): bigint`; `toIsoDate(d: Date): string` (local getters); `mapTx(tx: FinTSTx, currency: string): ProviderTransaction` (status `'booked'`, `providerId: null`, counterparty = `remoteName`, `counterpartyIban` only if `remoteAccountNumber` matches the IBAN pattern, purpose = `purpose`); `mapAccount(acc: FinTSAccount): ProviderAccount` (kind: Checking→checking, Savings/FixedDeposit→savings, CreditCard→credit_card, Securities→depot, else other; `ref` per Review Focus 5); `classifyTanMethod(m): FinTSTanMethod['kind']`.

- [ ] **Step 1:** Tests: `toMinor(-0.1 + -0.2,'EUR') === -30n`; `toMinor(1234.5,'EUR') === 123450n`; `toMinor(-0.07,'EUR') === -7n`; `toMinor(100,'JPY') === 100n`; `toMinor(NaN,…)` throws; `toIsoDate(new Date(2026,10,15)) === '2026-11-15'` (run file also under `TZ=Pacific/Kiritimati` and `TZ=America/Los_Angeles` via a vitest `env` per-test or separate spawned check); `mapTx` with `remoteAccountNumber:'DE89370400440532013000'` sets `counterpartyIban`, with `'1234567'` does not; two accounts with same number, different sub-account → distinct refs; IBAN account ref = IBAN.
- [ ] **Step 2–4:** RED → implement (minor-unit exponent table shared with FX — move it to `@budgedino/shared` money as `currencyExponent(code)` and use it in both places) → GREEN.
- [ ] **Step 5:** Commit `feat(server): fints port seam and mapping`.

### Task 2: Bank catalog, config schema, operator config, LibFintsPort

**Files:**

- Create: `src/server/src/connectors/fints/banks.ts`, `src/server/src/connectors/fints/config.ts`, `src/server/src/connectors/fints/lib-fints-port.ts`
- Modify: `src/server/src/config.ts` (env), `src/server/src/main.ts` (registration), `.env.example`, `README.md`
- Test: `tests/server/connectors/fints/config.test.ts`, `tests/server/config.test.ts`

**Interfaces:**

- `FINTS_BANKS: Record<'dkb'|'comdirect', { name: string; blz: string; url: string }>` — DKB `12030000` `https://fints.dkb.de/fints`, Comdirect `20041111` `https://fints.comdirect.de/fints` (implementer verifies both against the published FinTS institute list at fints.org/hbci-zka and records the source in a code comment).
- `fintsConfigSchema = z.object({ bank: z.enum(['dkb','comdirect']), userId: z.string().min(1).max(64), pin: z.string().min(1).max(64), tanMethodId: z.number().int().optional() }).strict()` — exported as the connector's `configSchema`.
- `LibFintsPort implements FinTSPort` — thin adapter over `FinTSConfig.forFirstTimeUse` / `fromBankingInformation` and `FinTSClient`; `debugEnabled` always false.
- Env: `BUDGEDINO_FINTS_PRODUCT_ID` (optional string), `BUDGEDINO_FINTS_PRODUCT_VERSION` (default `1.0`); `BUDGEDINO_CONNECTORS` may include `fints`; requesting `fints` without a product id → config error naming the variable.

- [ ] **Step 1:** Tests: schema rejects extra keys and unknown bank; config error when `fints` requested without product id (message names variable, contains no values); LibFintsPort compiles against lib-fints types (typecheck) — no network test.
- [ ] **Step 2–4:** RED → implement (`pnpm add lib-fints` in server; record LGPL note in ADR 0009 Task 7) → GREEN.
- [ ] **Step 5:** Commit `feat(server): fints bank catalog, config and lib-fints adapter`.

### Task 3: In-process dialog registry

**Files:**

- Create: `src/server/src/connectors/fints/dialogs.ts`
- Test: `tests/server/connectors/fints/dialogs.test.ts`

**Interfaces:**

- `class FinTSDialogRegistry { constructor(opts: { ttlMs: number; max: number; now: () => Date }); put(session: FinTSSession, meta: DialogMeta): string /* 32-byte random base64url handle */; take(handle: string): { session; meta } | undefined /* removes */; peek(handle) ; drop(handle): void; sweep(): void }` — default `ttlMs` 15 min (matches P1 challenge lifetime cap), `max` 100 (oldest evicted).
- `DialogMeta = { step: 'sync' | 'statements-probe'; tanReference: string; accountRef?: string; startedAt: string }`.
- The connector's `DialogState` is `{ handle, step }` only — never PIN/bankingInformation.

- [ ] **Step 1:** Tests: put→take returns session once; expired handle → undefined; `max` eviction; handle is unguessable length; `sweep` drops expired.
- [ ] **Step 2–5:** RED → implement → GREEN → commit `feat(server): fints in-process dialog registry`.

### Task 4: FinTSConnector authentication

**Files:**

- Create: `src/server/src/connectors/fints/connector.ts`
- Test: `tests/server/connectors/fints/auth.test.ts`, `tests/support/fints/scripted-port.ts`

**Interfaces:**

- `createFinTSConnector(deps: { port: FinTSPort; dialogs: FinTSDialogRegistry; product: { id: string; version: string } }): Connector` with `type: 'fints'`, `experimental: false`, `challengeKinds: ['decoupled','code','image']`, `configSchema: fintsConfigSchema`, `rateLimit` per Global Constraints.
- `ScriptedFinTSPort` (tests): scenario-driven fake implementing `FinTSPort`, e.g. `{ tanMethods, syncRequiresTan: 'decoupled'|'code'|'photo'|false, decoupledPendingPolls, statementsRequireTan: boolean, accounts, transactions, failWith?: 'wrong-pin'|'locked'|'server-error' }`, recording every call.
- Auth algorithm (connector decides; documents in file header):
  1. `openFirstTime` → `synchronize()`; failure with PIN error codes (9910/9931/9942 family, see lib-fints `bankAnswers`) → `ConnectorAuthError('declined')`; other failure → throw a generic error (challenge service maps to 502).
  2. TAN method: `config.tanMethodId` if given and available; else prefer `decoupled`, then `code`, then `photo`; `chiptan-optical` never auto-selected (P3 can't render flicker) — if it's the only method → `ConnectorAuthError('declined', 'no supported TAN method')`.
  3. `selectTanMethod` → `synchronize()` again; `requiresTan` → challenge: decoupled → `{kind:'decoupled', message: bank text (sanitised, ≤200 chars), pollAfterMs: 3000}`; code → `{kind:'code', message}`; photo → `{kind:'image', message, imagePngBase64}` (only PNG/JPEG mime; else declined).
  4. After sync done: statements probe on the first checking/credit account for the last 3 days; if it `requiresTan` → raise a second challenge (step `statements-probe`) so the user's SCA also covers account access (PSD2 90-day exemption).
  5. Done → `state = { bankingInformation, tanMethodId, systemId }`, `consentExpiresAt = now + 90 days`.
  - `continueAuth`: `take(handle)` missing → `ConnectorAuthError('timeout')`; decoupled answer → `*WithTan(ref)` without tan; still `requiresTan` → re-`put` and return the same decoupled challenge (P1 polling semantics); code/image → `*WithTan(ref, code)`; bank rejects TAN → return a fresh `code` challenge up to 3 attempts, then `ConnectorAuthError('too_many_attempts')`; wrong answer kind → `InvalidAnswerError` (session re-`put`).
  - `cancelAuth`: `drop(handle)`.
- [ ] **Step 1:** Tests (scripted): DKB-like decoupled with 2 pending polls → done; pushTAN code wrong then right → done; photoTAN → image challenge with base64 PNG; chipTAN-optical only → declined; wrong PIN → declined; statements-probe TAN → second challenge then done; handle lost (new registry instance) → timeout; PIN/userId never appear in any returned challenge/dialog/state JSON except `state.bankingInformation` (assert by canary search over JSON of every step).
- [ ] **Step 2–5:** RED → implement → GREEN → commit `feat(server): fints authentication with typed challenges`.

### Task 5: Accounts and transactions

**Files:**

- Modify: `src/server/src/connectors/fints/connector.ts`
- Test: `tests/server/connectors/fints/fetch.test.ts`

**Interfaces:**

- `listAccounts(state, ctx)`: from `openFromState(...).accounts()` → `mapAccount`; no network if UPD present.
- `fetchTransactions(state, accountRef, since, ctx)`:
  - depot → `{ ok: true, transactions: [] }` (holdings in the net-worth plan);
  - credit_card → `getCreditCardStatements`; others → `getStatements(from, to=today)`;
  - `from = since ?? today − 89 days` (never request beyond the SCA-exempt window unattended);
  - `requiresTan` → `{ ok:false, reason:'needs_attention', state }` (no dialog left open — `drop`);
  - PIN error → `needs_attention`; network/5xx → `{ ok:false, reason:'temporary' }`;
  - success → mapped txs + balance (`getBalance`, best effort) + `state` with refreshed `bankingInformation` when `bankingInformationUpdated`.
- [ ] **Step 1:** Tests: first sync requests exactly 89 days; `since` honoured; TAN on fetch → needs_attention without throwing, no registry entry left; credit-card path used for credit accounts; depot returns empty ok; bankingInformation update returned in state; Review Focus 5 refs stable across calls.
- [ ] **Step 2–5:** RED → implement → GREEN → commit `feat(server): fints accounts and transactions`.

### Task 6: Contract suite, API integration

**Files:**

- Create: `tests/server/connectors/fints/contract.test.ts`, `tests/server/connectors/fints/api.int.test.ts`
- Modify: `tests/support/route-fixtures.ts` only if new GET routes (none expected)

- [ ] **Step 1:** `runConnectorContract('fints', () => createFinTSConnector({ port: new ScriptedFinTSPort(...), ... }), script)` — script answers decoupled/code/image challenges and provides a failing state factory (statements require TAN).
- [ ] **Step 2:** Integration through the real P1 API (buildApp with the fints connector + scripted port): `POST /connectors {type:'fints', config:{bank:'dkb', userId, pin}}` → decoupled challenge → poll answers → done → accounts discovered → sync ingests mapped transactions → `GET /transactions` shows them categorized; a later scheduled run whose statements require TAN → connector `needs_attention` + one notification; raw DB dump contains no PIN/userId canary (incl. hex).
- [ ] **Step 3:** GREEN → commit `test(server): fints contract and API integration`.

### Task 7: Opt-in live test, docs, ADR

**Files:**

- Create: `tests/live/fints.live.test.ts` (vitest project `live`, excluded from `ci/check.sh`), `docs/adr/0009-fints-in-memory-dialogs.md`
- Modify: `docs/specs/sync-and-connectors.md` (FinTS section: TAN method preference, 89-day first window, SCA probe, needs_attention semantics, single-instance dialogs), `docs/specs/self-hosting.md` + README (FinTS product registration: what, where, env vars; LGPL dependency note), `AGENTS.md` (live test command)

- [ ] **Step 1:** Live test reads `FINTS_LIVE_BANK`, `FINTS_LIVE_USER`, `FINTS_LIVE_PIN`, `BUDGEDINO_FINTS_PRODUCT_ID`; skips unless all set; runs auth (prints only the challenge message, prompts for TAN on stdin for code methods, polls up to 3 min for decoupled), lists accounts (prints count and kinds only), fetches 30 days for the first checking account (prints count and date range only — never amounts/names). `pnpm test:live`.
- [ ] **Step 2:** Docs + ADR (context: lib-fints dialog not serialisable; decision: in-process registry with handle in DialogState; consequences: restart drops open challenges, single instance).
- [ ] **Step 3:** `bash ci/check.sh` green → commit `docs: fints connector, product registration, live test`.

---

## Owner actions (outside the code)

- Register a FinTS product at the Deutsche Kreditwirtschaft (free) — needed for the live test and production.
- Run `pnpm test:live` once with DKB credentials and confirm the DKB app approval flow end to end.

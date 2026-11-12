# P3.5 Daily Driver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make BudgeDino usable day to day without the CLI or API: manage budgets, the household (members, invites), categories and rules in the app, search and filter transactions, and drill from Home into a category's transactions.

**Architecture:** Three small server tasks add the missing API surface (transaction text search over decrypted fields, member/invite listing and revocation, category create/update, rule list/delete), each with its spec update, OpenAPI regeneration and visibility-harness fixtures. Four mobile tasks add the screens on top, following the existing More/Settings patterns (`SettingsPage`, `List.Item`, FAB, TanStack Query hooks in `queries.ts`).

**Tech Stack:** Fastify + zod + Drizzle (server), Vitest; Expo Router, react-native-paper MD3, TanStack Query, jest-expo + RNTL 14 (async `render`/`fireEvent`).

**Spec:** `docs/specs/budgets.md`, `docs/specs/household-and-access.md`, `docs/specs/categorization.md`, `docs/specs/mobile.md` (each task updates its spec section first). Decisions not in the specs are marked **[call]** below and are recorded in the spec by the task that implements them.

## Global Constraints

- Every route declares `config.access` (`public` | `member` | `admin`); a new GET route needs a `tests/support/route-fixtures.ts` entry per path parameter, and the visibility harness requires member B to get 2xx from every member/admin GET route unless listed in `OWNER_POSITIVE_CONTROL_EXEMPT` with a comment.
- Reads of accounts and transactions go through `visibleAccountIds(db, auth)`.
- Money: integer minor units + ISO 4217; never floating point (also in the app's amount input).
- Logs never contain amounts, payees, IBANs, counterparty names, purposes or invite tokens.
- Every behavioural change updates the relevant `docs/specs/<area>.md` in the same commit; `pnpm openapi` regenerated and committed when routes change.
- Mobile: RNTL 14 `render`/`fireEvent` are async (`await`); text colours always from the theme; layouts must wrap at font scale 2.
- Conventional commits, no AI attribution. `SKIP_INTEGRATION=1 bash ci/check.sh` green before each commit (integration suites run where Docker is available).

## Decisions [call]

- **D1 Search:** `GET /transactions?q=` matches case-insensitively (`toLocaleLowerCase('de-DE')`) as a substring of the decrypted counterparty name **or** purpose; `q` is trimmed, 2–64 characters (else 400). Encrypted fields cannot be searched in SQL, so the server scans visible rows in keyset order in batches of 500 and stops when `limit` matches are found or **5,000 rows** were scanned; `nextCursor` then points at the last _scanned_ row, so paging continues the scan. Response adds `scannedUntil` (booking date of the last scanned row, or null when the scan reached the end).
- **D2 Uncategorized filter:** `GET /transactions?uncategorized=true` returns transactions with `categoryId IS NULL` (mutually exclusive with `categoryId`, else 400).
- **D3 Members:** `GET /households/members` (member access) lists the caller's household: `id`, `displayName`, `role`, `joinedAt`, `isSelf`, `disabled`; `email` only when the caller is an admin. Removing members is out of scope.
- **D4 Invites:** `GET /households/invites` (admin) lists pending invites (unused, unexpired): `id`, `role`, `expiresAt`. `DELETE /households/invites/:id` (admin) deletes a pending invite: 204; already used → 409; unknown, expired or another household's → 404. Tokens are never listed again (only the hash is stored).
- **D5 Join link:** the app shows a new invite as a QR code and a share text containing `budgedino://register?server=<serverUrl>&invite=<token>`. The register screen prefills both from the link, validates the server with `validateServerUrl`, and shows "Joining a household on <host>" prominently, so a phishing link with a foreign host is visible before a password is typed.
- **D6 Categories:** admins manage categories: `POST /categories` `{ name (1–40 chars, trimmed, unique per household case-insensitively, else 409), group? (≤40), isIncome? }` → 201 with the category; `PATCH /categories/:id` `{ name?, group?, archived? }`. The Transfer category (`isTransfer`) cannot be renamed or archived (422). Archived categories stay on old transactions and in existing budgets but are hidden from every picker.
- **D7 Rules:** `GET /rules` (member) lists the rules the caller created: `id`, `categoryId`, `match` (`{ kind: 'iban' | 'counterpartyContains', value }`, decrypted), `createdAt`; `DELETE /rules/:id` deletes one of the caller's own rules (204) or 404. Other members' rules are never listed (they can name a counterparty from an owner-only account). Deleting a rule does not recategorize past transactions.
- **D8 Budget editing:** stays admin-only (as the routes already are); members see budgets read-only in the app.
- **D9 Screens:** More gains "Budgets", "Household" and "Categories & rules" (above Settings). Transactions tab gains a search field and filter chips (category, account, date range); Home breakdown rows navigate to Transactions filtered by that category (or uncategorized) and the displayed period.

## Review Focus

1. Search with umlauts, mixed case or SQL wildcard characters (`Müller`, `MÜLLER`, `50%_off`) → plain case-insensitive substring match, no wildcard semantics (Task 1 test).
2. Search in a household with more than 5,000 visible rows and no match in them → returns quickly with an empty page, `nextCursor` set and `scannedUntil` set; the app shows "Searched back to <date>" with a "Search further" button instead of "No results" (Tasks 1, 6).
3. Amount input `1.234,56`, `12,5`, `0`, `-5`, `abc`, empty → only positive amounts with at most 2 decimals parse; the form shows a field error, never sends a float (Task 4).
4. Revoking an invite that was used in the meantime → 409, the app refreshes the list and says it was already used (Tasks 2, 5).
5. A non-admin opens Budgets or Household → read-only views, no FAB, no 403 errors surfaced as crashes (Tasks 4, 5).

---

### Task 1: Transaction search and uncategorized filter (server)

**Files:**

- Modify: `src/server/src/repositories/transactions.ts` (`TransactionQuery`, `queryTransactions`), the `GET /transactions` route in `src/server/src/categorization/routes.ts`, its zod query/response schemas in `src/shared/src/api/`
- Modify: `docs/specs/categorization.md` ("Listing: `GET /transactions`"), `docs/api/openapi.json` (regenerate)
- Test: `tests/server/categorization/search.int.test.ts` (new), schema test in the existing shared API test file

**Interfaces:**

- Produces: query params `q?: string`, `uncategorized?: boolean`; response `TransactionPage & { scannedUntil: string | null }`; exported `SEARCH_SCAN_CAP = 5000`, `SEARCH_BATCH = 500` from the repository.

- [ ] **Step 1: Write failing integration tests** (Testcontainers, existing helpers in `tests/support`):
  - `finds by counterparty and by purpose, case-insensitively`: rows with counterparty `Bäckerei Müller` and purpose `MÜLLER Brötchen`; `q=müller` returns both, `q=xyz` none.
  - `treats % and _ literally`: counterparty `50%_off shop`; `q=50%_` matches it, `q=%` matches only rows containing `%`.
  - `stops after the scan cap and continues with the cursor`: 5,200 visible rows, the only match is the oldest; first call returns `items: []`, non-null `nextCursor` and `scannedUntil`; following the cursor returns the match and `scannedUntil: null`.
  - `never searches invisible rows`: a matching row on another member's owner-only account is not returned.
  - `uncategorized=true returns only null categories; with categoryId it is 400`; `q` of 1 or 65 characters is 400.
- [ ] **Step 2: Run** `pnpm vitest run --project integration tests/server/categorization/search.int.test.ts` → FAIL.
- [ ] **Step 3: Implement** in `queryTransactions`: without `q`, unchanged SQL path (plus `isNull(categoryId)` for `uncategorized`). With `q`: loop over keyset batches of `SEARCH_BATCH` using the same ordering and cursor format, decrypt with `toTransaction`, keep rows whose lowercased counterparty name or purpose `includes` the lowercased query, stop at `limit` matches or `SEARCH_SCAN_CAP` scanned rows. Never log `q`.
- [ ] **Step 4: Update spec** with D1/D2 (copy the numbers), `pnpm openapi`.
- [ ] **Step 5: Run** the new tests and `SKIP_INTEGRATION=1 bash ci/check.sh` → PASS.
- [ ] **Step 6: Commit** `feat(server): transaction text search and uncategorized filter`.

### Task 2: Household members and invite management (server)

**Files:**

- Modify: `src/server/src/households/routes.ts`, `src/server/src/households/invites.ts`, shared schemas in `src/shared/src/api/`
- Modify: `tests/support/route-fixtures.ts` (`:id` for invites), `tests/server/access/visibility.int.test.ts` (`OWNER_POSITIVE_CONTROL_EXEMPT` entry for `GET /households/invites`, comment: admin-only), `docs/specs/household-and-access.md`, `docs/api/openapi.json`
- Test: `tests/server/households/members.int.test.ts` (new)

**Interfaces:**

- Produces: `GET /households/members` → `{ members: { id, displayName, role, joinedAt, isSelf, disabled, email? }[] }` ordered by `joinedAt`; `GET /households/invites` → `{ invites: { id, role, expiresAt }[] }`; `DELETE /households/invites/:id` → 204 | 404 | 409; existing `POST /households/invites` unchanged (returns the token once).

- [ ] **Step 1: Failing tests:** member sees both members without `email`, admin sees `email`; `isSelf` true only for the caller; another household's members never appear; invites list shows only unused and unexpired invites of the caller's household and never a token or hash; member gets 403 on list and delete; delete pending → 204 and gone; delete used → 409; delete expired, unknown or another household's → 404.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the three routes per D3/D4 (decrypt display name and email with the household key; email only for admins).
- [ ] **Step 4: Spec + fixtures + openapi**; the visibility harness must pass with the new GET routes.
- [ ] **Step 5: Run** tests and check → PASS.
- [ ] **Step 6: Commit** `feat(server): list members, list and revoke invites`.

### Task 3: Category management and rules API (server)

**Files:**

- Modify: `src/server/src/categorization/routes.ts`, `src/server/src/categorization/rules.ts`, shared schemas
- Modify: `tests/support/route-fixtures.ts`, `docs/specs/categorization.md`, `docs/api/openapi.json`
- Test: `tests/server/categorization/manage.int.test.ts` (new)

**Interfaces:**

- Produces: `POST /categories`, `PATCH /categories/:id` (admin, D6); `GET /rules`, `DELETE /rules/:id` (member, D7). `Category` schema unchanged.

- [ ] **Step 1: Failing tests:** create → 201 and listed by `GET /categories`; duplicate name with other casing → 409; name of 0 or 41 characters → 400; rename and archive work; archiving or renaming the Transfer category → 422; another household's category → 404; member → 403. Rules: member sees only own rules with decrypted `match`; deleting another member's rule → 404; deleting own → 204, rule gone, previously recategorized transactions unchanged.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** per D6/D7.
- [ ] **Step 4: Spec + fixtures + openapi.**
- [ ] **Step 5: Run** → PASS.
- [ ] **Step 6: Commit** `feat(server): manage categories, list and delete own rules`.

### Task 4: Budgets screens (mobile)

**Files:**

- Create: `src/mobile/src/format/money-input.ts`, `src/mobile/src/budgets/{BudgetsScreen,BudgetForm,queries}.tsx|ts`, `src/mobile/app/(app)/more/budgets/{index,new,[id]}.tsx`
- Modify: `src/mobile/src/more/MoreScreen.tsx` (entries Budgets, Household, Categories & rules above Settings; D9), `docs/specs/mobile.md`
- Test: `src/mobile/src/format/__tests__/money-input.test.ts`, `src/mobile/src/budgets/__tests__/budgets.test.tsx`

**Interfaces:**

- Produces: `parseMoneyInput(text: string, currency: string): { ok: true; minor: bigint } | { ok: false; error: string }` (uses `currencyExponent` from `@budgedino/shared`); `useCategories()` hook in `src/mobile/src/budgets/queries.ts` returning non-archived categories (reused by Tasks 6 and 7); `useIsAdmin()` from the session/home data already available (if none exists, derive from `GET /households/members` `isSelf` row's `role` and export it from `src/mobile/src/household/queries.ts` in this task).

- [ ] **Step 1: Failing tests:** `parseMoneyInput('1.234,56','EUR')` → 123456n; `'12,5'` → 1250n; `'500'` → 50000n; `'0'`, `'-5'`, `'abc'`, `''`, `'1,234'` (3 decimals) → error; `'100','JPY'` → 100n. Screen: list shows name, period, `amount`; admin sees FAB and can create (POST body has `amount: { minor: '50000', currency: 'EUR' }`, selected `categoryIds`, `periodKind`), edit, and delete after confirm; member sees no FAB and no edit actions; archived categories are not offered in the picker but an existing budget's archived category is still shown as a chip.
- [ ] **Step 2: Run** `pnpm mobile:test -- src/format src/budgets` → FAIL.
- [ ] **Step 3: Implement** list (`SettingsPage`, `List.Item`, FAB), form (name, category multi-select chips, period segmented buttons, amount field with `parseMoneyInput` error text), delete with confirm dialog; invalidate the home and budgets queries after mutations.
- [ ] **Step 4: Spec** (mobile.md: Budgets section, More entries).
- [ ] **Step 5: Run** tests and check → PASS.
- [ ] **Step 6: Commit** `feat(mobile): manage budgets`.

### Task 5: Household screen and join link (mobile)

**Files:**

- Create: `src/mobile/src/household/{HouseholdScreen,InviteSheet,queries}.tsx|ts`, `src/mobile/app/(app)/more/household.tsx`
- Modify: `src/mobile/app/(auth)/register.tsx` (prefill from `server` and `invite` params, D5), `docs/specs/mobile.md`
- Test: `src/mobile/src/household/__tests__/household.test.tsx`, register prefill test in `src/mobile/app/(auth)/__tests__/`

**Interfaces:**

- Consumes: Task 2 routes. Produces: `buildJoinLink(serverUrl: string, token: string): string` in `src/mobile/src/household/join-link.ts`.

- [ ] **Step 1: Failing tests:** members list with "You" marker and role; admin sees "Invite someone" (role picker member/admin) → shows QR (value = `buildJoinLink(...)`) and a Share button (`Share.share` called with text containing the link); pending invites listed with expiry and a revoke action; revoke 409 → message "This invite was already used" and list refetch; member sees members only. Register: opening with `server=https://budget.example.com&invite=abc` prefills the invite and stores the normalized server after `validateServerUrl` passes, and shows "Joining a household on budget.example.com"; an `http://` server in a release build is rejected with the existing message.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** (`react-native-qrcode-svg`, `Share` from react-native; the token is held in component state only, never in the query cache or MMKV, and is cleared when the sheet closes).
- [ ] **Step 4: Spec.**
- [ ] **Step 5: Run** → PASS.
- [ ] **Step 6: Commit** `feat(mobile): household members and invites with join link`.

### Task 6: Transaction search, filters and Home drill-down (mobile)

**Files:**

- Modify: `src/mobile/src/transactions/{TransactionsScreen,queries}.tsx|ts`, `src/mobile/src/home/BreakdownList.tsx`, `src/mobile/app/(app)/transactions.tsx` (read `categoryId`, `uncategorized`, `from`, `to` params), `docs/specs/mobile.md`
- Test: `src/mobile/src/transactions/__tests__/search.test.tsx`, breakdown navigation test in `src/mobile/src/home/__tests__/`

**Interfaces:**

- Consumes: Task 1 (`q`, `uncategorized`, `scannedUntil`), `useCategories()` from Task 4.

- [ ] **Step 1: Failing tests:** typing in the search field queries `q` after 300 ms debounce and not for fewer than 2 characters; category and account chips set `categoryId`/`accountId`; a date-range chip from route params shows "1 Nov – 30 Nov" and can be removed; empty page with `scannedUntil` shows "Searched back to <date>" and "Search further" (fetches next page); tapping a Home breakdown row navigates to `/transactions` with that category (or `uncategorized=1`) and the period's `from`/`to`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** (search query is part of the query key; search results are not persisted to the offline cache).
- [ ] **Step 4: Spec.**
- [ ] **Step 5: Run** → PASS.
- [ ] **Step 6: Commit** `feat(mobile): search and filter transactions, drill down from Home`.

### Task 7: Categories and rules screens (mobile)

**Files:**

- Create: `src/mobile/src/categories/{CategoriesScreen,RulesScreen,queries}.tsx|ts`, `src/mobile/app/(app)/more/categories/{index,rules}.tsx`
- Modify: `docs/specs/mobile.md`
- Test: `src/mobile/src/categories/__tests__/categories.test.tsx`

**Interfaces:**

- Consumes: Task 3 routes, `useCategories()` (extend with an `includeArchived` option here).

- [ ] **Step 1: Failing tests:** categories grouped by `group`, archived ones in a collapsed "Archived" section; admin can add (409 shows "A category with this name exists"), rename and archive/unarchive; Transfer shows no edit actions; member sees the list read-only; rules screen lists own rules as "<counterparty or IBAN> → <category>" and deletes after confirm, with an explanation that past transactions keep their category.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Spec.**
- [ ] **Step 5: Run** → PASS, then the full `SKIP_INTEGRATION=1 bash ci/check.sh`.
- [ ] **Step 6: Commit** `feat(mobile): manage categories and rules`.

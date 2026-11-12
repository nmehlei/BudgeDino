# Spec: Categorization

- Status: living spec (source of truth for behaviour)
- Origin: [founding design](2026-11-08-budgedino-design.md) §7. **[owner]** = decided by the owner,
  **[call]** = AI's call, may be challenged.

- Default German-household category set (Groceries, Eating out, Transport, Housing, Utilities,
  Insurance, Subscriptions, Shopping, Health, Kids, Savings/Investments, Income, …), editable. **[call]**
- Pipeline: (1) household rules (payee / IBAN / description pattern / amount → category),
  (2) learned matches from past corrections (same counterparty → same category),
  (3) built-in heuristics (MCC codes when available, known merchants), (4) "uncategorized".
  A correction offers "always do this for <counterparty>" which creates a rule. **[call]**
- **Internal transfers** between household accounts (incl. between members, and cash-to-depot) are
  detected (matching opposite amounts across known accounts within a few days) and excluded from
  spending and budgets. **[call]**
- All categorization runs locally on the server; no external AI. **[call]**

## Implemented behaviour (Task 11)

### Precedence

`manual` (never overwritten) > household **rules** (priority high to low, then newest) > **learned**
matches > **heuristics** (MCC table, merchant keywords, salary) > uncategorized (`none`). The result and
its source (`rule` / `learned` / `heuristic` / `manual` / `none`) are stored on the transaction.

- **Rules** (`rules.match_enc`, encrypted `RuleMatch` JSON, household-scoped): `counterpartyContains`,
  `counterpartyIban`, `purposeContains`, `amountMinMinor` / `amountMaxMinor` (bounds on the _absolute_
  amount, inclusive), `accountId`. Case-insensitive; all present fields must match; an empty match never
  matches. A new rule gets a priority above all existing ones.
- **Learned**: `counterparty_bidx` -> category of the most recent `manual` categorization in the household
  (`transactions.category_set_at`). Only manual categorizations teach.
- **Salary**: a positive amount whose counterparty or purpose contains LOHN / GEHALT / SALARY (word
  boundary) -> Income, checked _before_ MCC and merchant keywords (an employer such as "Deutsche Bahn AG"
  must not turn a salary into Transport). Any other positive amount without a match stays uncategorized.

### Heuristic tables

MCC: 5411, 5422, 5441, 5451, 5462, 5499 -> Groceries; 5812, 5813, 5814 -> Eating out; 4111, 4121, 4131,
5541, 5542, 7523 -> Transport; 4900 -> Utilities; 5912 -> Health; 4814, 4899 -> Subscriptions.

Merchant keywords (case-insensitive, word-boundary, counterparty first then purpose; first listed hit
wins; tables live in `categorization/engine.ts`): REWE, EDEKA, ALDI, LIDL, PENNY, NETTO, KAUFLAND,
BIOCOMPANY, DENNS -> Groceries; DB VERTRIEB, DEUTSCHE BAHN, BVG, MVG, HVV, FLIXBUS -> Transport; NETFLIX,
SPOTIFY, DISNEY -> Subscriptions; DM-DROGERIE, ROSSMANN -> **Health** (drugstore goods; Shopping via a
rule if preferred); LIEFERANDO, MCDONALD, STARBUCKS, BURGER KING -> Eating out. Tables resolve to a
household's categories by (default) name; renamed categories simply drop out.

### When it runs

`categorize` runs on ingest (`onIngested`) for inserted/updated transactions, skipping `manual` ones and
transfer-group members. **R16:** only new rows and rows without a category (`none`) are categorized; an
update of a row that already has a category (e.g. pending -> booked) keeps it, even if rules changed in
between. Rules created with `applyToCounterparty` recategorize history explicitly.

### Corrections: `PATCH /transactions/:id`

`{ categoryId, applyToCounterparty? }` sets the category as `manual`. With `applyToCounterparty` a rule
is created (`counterpartyIban` if the transaction has an IBAN, else `counterpartyContains` = the full
counterparty name; 422 when it has neither) and the household's non-manual history of that counterparty
is recategorized. The category must belong to the household (422); a transaction the caller cannot see is 404.

### Category management: `POST /categories`, `PATCH /categories/:id` (admin)

`POST { name, group?, isIncome?, icon?, color? }` -> 201 `{ category }`. `name` is trimmed, 1-40 characters, unique per
household case-insensitively (`de-DE` lower-casing), else 409; `group` is trimmed, at most 40
characters, and an empty string stores `null`. `PATCH { name?, group?, archived?, icon?, color? }` (at least one field)
renames, regroups, (un)archives or restyles (`icon`/`color` accept `null` to clear; see "Icon and colour"); a rename colliding with another category is 409, another household's
category is 404. The Transfer category (`isTransfer`) is immutable: any PATCH of it is 422. Archived
categories stay on old transactions and in existing budgets and keep being returned by `GET /categories`
with `archived: true`; the app hides them from every picker. Archiving does not disable rules pointing at the
category: new transactions can still land in an archived category. Members get 403.

### Rules: `GET /rules`, `DELETE /rules/:id` (member)

`GET /rules` lists only the rules the caller created: `id`, `categoryId`, `match` (`{ kind: 'iban' |
'counterpartyContains', value }`, decrypted for the creator only; the value is sensitive and never logged)
and `createdAt`. Other members' rules are never listed (they can name a counterparty from an owner-only
account). `DELETE /rules/:id` removes one of the caller's own rules (204); anything else (another member's,
another household's, unknown) is 404. Deleting a rule does not recategorize past transactions.

### Splits: `POST /transactions/:id/splits`

`{ parts: [{ categoryId, amount: { minor, currency } }] }` replaces existing splits. Each part must be
non-zero, have the transaction's sign and currency, and the parts must sum to the transaction amount, else 422. Amounts are stored encrypted.

### Transfers

Opposite amounts (same currency and absolute minor units) on two _different_ household accounts, both
booked, at most 4 days apart, are paired. A candidate pair is rejected when either side has a known
counterparty IBAN that differs from the other account's IBAN (a third party, e.g. a merchant payment
next to an unrelated deposit); sides without IBANs are still paired. Ranking: counterparty IBAN equal to the other account's IBAN
first, then smallest date gap; each transaction is in at most one pair. Both get a shared
`transfer_group_id` and the Transfer category with source `rule` (a manual category is kept; the group
id is still set so budgets can exclude the pair). Runs after categorization on ingest.

### R15: household-wide effects, caller-scoped responses

Transfer detection works on **all** household accounts, including other members' `owner_only` accounts
(budgets may count them). Rules, `applyToCounterparty` and learned matches are scoped by R18. API responses, and any counts
in them (`recategorized`), only cover transactions the caller can see; a pair with a hidden account is
visible only through the normal visibility gate, so no response reveals the hidden counterpart.

### R18: members create rules; scoped effects

Members (not only admins) may create rules (via `PATCH /transactions/:id` with `applyToCounterparty`); the
creator is stored in `rules.created_by`. A rule's effects, both future ingest matching and the
`applyToCounterparty` history recategorization, only apply to transactions on accounts that are visible to
the rule's creator (`household`, or owned by the creator) **or** have `countsTowardBudgets=true` (so budgets
stay consistent). Another member's `owner_only` non-counting account is never touched by it. Learned matches
follow the same rule, attributed to the owner of the account they were learned on.

### Listing: `GET /transactions`

`?from&to&accountId&categoryId&uncategorized&q&cursor&limit` (limit 1-200, default 50): visible
transactions only, decrypted, newest booking date first, keyset cursor `<bookingDate>|<id>`, with
splits. The response carries `transactions`, `nextCursor` and `scannedUntil` (always `null` without `q`).

- **Uncategorized filter:** `uncategorized=true` (or `1`) returns transactions with
  `categoryId IS NULL`. It is mutually exclusive with `categoryId` (400); any other value is 400.
- **Text search:** `q` matches case-insensitively (`toLocaleLowerCase('de-DE')`) as a plain substring
  of the decrypted counterparty name **or** purpose (no wildcard semantics for `%` or `_`). `q` is
  trimmed, then must be 2-64 characters (else 400). Counterparty and purpose are encrypted, so the
  server scans visible rows in keyset order in batches of 500 (`SEARCH_BATCH`) and stops when `limit`
  matches were found or 5,000 rows (`SEARCH_SCAN_CAP`) were scanned. `nextCursor` then points at the
  last _scanned_ row, so paging continues the scan, and `scannedUntil` is the booking date of that
  row; a page may therefore be empty with a non-null `nextCursor`. `scannedUntil` is `null` when the
  scan reached the end. `q` is never logged.
- **Drill-down semantics:** `categoryId` / `uncategorized` match the transaction's **own** `category_id`
  (or its absence) in the period. Split parts and the budget rules (budget-counting accounts only, transfers and
  uncategorised income excluded) are not applied, so a list opened from the Home breakdown can differ from the
  breakdown amount.

### Categories: `GET /categories`

Member route. The caller's household categories (`id`, `name`, `group`, `isIncome`, `isTransfer`,
`archived`, `icon`, `color`), ordered by name, archived ones included so old transactions still resolve. Never another
household's. No path parameters, so the visibility harness probes it without a fixture.

### Icon and colour

Every category has an optional `icon` and `color` (nullable text columns), returned by `categoryInfo`
(`GET/POST/PATCH /categories`) as nullable strings and accepted by `POST`/`PATCH`.

- `icon` is a MaterialCommunityIcons name from the allowlist `CATEGORY_ICONS` in `@budgedino/shared`
  (40 names: the 19 defaults below, `tag`, and 20 extras). A mobile test checks that each name exists in
  the installed glyph map. Anything else is 400.
- `color` is a key from `CATEGORY_COLOR_KEYS` (18 keys: `green`, `orange`, `blue`, `brown`, `amber`,
  `indigo`, `violet`, `pink`, `rose`, `apricot`, `teal`, `sky`, `red`, `slate`, `olive`, `gold`,
  `accent`, `grey`). `CATEGORY_COLORS` maps each to a `{ light, dark }` hex; each value reaches 3:1
  contrast against the theme surface (`#FBFDFB` / `#151B18`), checked by a unit test. Anything else is 400.
- `null` on `PATCH` clears the stored value; omitting a field leaves it unchanged.
- **Fallback** (`resolveCategoryStyle`): per field, a null or unknown value resolves to the icon `tag`
  and a colour `CATEGORY_COLOR_KEYS[fnv1a(id) % 16]` (deterministic; `accent` and `grey` excluded).
- **Internal `key`:** a nullable stable slug on the 19 seeded defaults, unique per household where set
  (partial unique index). It is never returned by the API and never accepted from a client.

| Default             | Icon                    | Colour    |
| ------------------- | ----------------------- | --------- |
| groceries           | `cart`                  | `green`   |
| eating-out          | `silverware-fork-knife` | `orange`  |
| transport           | `bus`                   | `blue`    |
| housing             | `home-variant`          | `brown`   |
| utilities           | `lightning-bolt`        | `amber`   |
| insurance           | `shield-check`          | `indigo`  |
| subscriptions       | `play-box-multiple`     | `violet`  |
| shopping            | `shopping`              | `pink`    |
| health              | `heart-pulse`           | `rose`    |
| kids                | `teddy-bear`            | `apricot` |
| leisure             | `ticket`                | `teal`    |
| travel              | `airplane`              | `sky`     |
| gifts-donations     | `gift`                  | `red`     |
| fees                | `receipt-text`          | `slate`   |
| cash                | `cash`                  | `olive`   |
| savings-investments | `piggy-bank`            | `gold`    |
| income              | `cash-plus`             | `accent`  |
| transfer            | `swap-horizontal`       | `grey`    |
| uncategorized       | `help`                  | `grey`    |

Bootstrap seeds `key`, `icon` and `color` for new households. Migration `0013` backfills existing
households by exact match on the English default name, only where the household has exactly one
category with that name; renamed or duplicated defaults stay null and render with the fallback.

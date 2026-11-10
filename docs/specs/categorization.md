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

`?from&to&accountId&categoryId&cursor&limit` (limit 1-200, default 50): visible transactions only,
decrypted, newest booking date first, keyset cursor `<bookingDate>|<id>`, with splits.

### Categories: `GET /categories`

Member route. The caller's household categories (`id`, `name`, `group`, `isIncome`, `isTransfer`,
`archived`), ordered by name, archived ones included so old transactions still resolve. Never another
household's. No path parameters, so the visibility harness probes it without a fixture.

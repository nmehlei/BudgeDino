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
  `counterpartyIban`, `purposeContains`, `amountMinMinor` / `amountMaxMinor` (bounds on the *absolute*
  amount, inclusive), `accountId`. Case-insensitive; all present fields must match; an empty match never
  matches. A new rule gets a priority above all existing ones.
- **Learned**: `counterparty_bidx` -> category of the most recent `manual` categorization in the household
  (`transactions.category_set_at`). Only manual categorizations teach.
- **Salary**: a positive amount whose purpose contains LOHN / GEHALT / SALARY (word boundary) -> Income.
  Any other positive amount without a match stays uncategorized.

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
transfer-group members. A booked update of a pending row keeps its category when nothing matches any more;
only rows without a category become `none`.

### Corrections: `PATCH /transactions/:id`

`{ categoryId, applyToCounterparty? }` sets the category as `manual`. With `applyToCounterparty` a rule
is created (`counterpartyIban` if the transaction has an IBAN, else `counterpartyContains` = the full
counterparty name; 422 when it has neither) and the household's non-manual history of that counterparty
is recategorized. The category must belong to the household (422); a transaction the caller cannot see is
404.

### Splits: `POST /transactions/:id/splits`

`{ parts: [{ categoryId, amount: { minor, currency } }] }` replaces existing splits. Each part must be
non-zero, have the transaction's sign and currency, and the parts must sum to the transaction amount, else
422. Amounts are stored encrypted.

### Transfers

Opposite amounts (same currency and absolute minor units) on two *different* household accounts, both
booked, at most 4 days apart, are paired. Ranking: counterparty IBAN equal to the other account's IBAN
first, then smallest date gap; each transaction is in at most one pair. Both get a shared
`transfer_group_id` and the Transfer category with source `rule` (a manual category is kept; the group
id is still set so budgets can exclude the pair). Runs after categorization on ingest.

### R15: household-wide effects, caller-scoped responses

Rules, `applyToCounterparty`, learned matches and transfer detection work on **all** household accounts,
including other members' `owner_only` accounts (budgets may count them). API responses, and any counts
in them (`recategorized`), only cover transactions the caller can see; a pair with a hidden account is
visible only through the normal visibility gate, so no response reveals the hidden counterpart.

### Listing: `GET /transactions`

`?from&to&accountId&categoryId&cursor&limit` (limit 1-200, default 50): visible transactions only,
decrypted, newest booking date first, keyset cursor `<bookingDate>|<id>`, with splits.

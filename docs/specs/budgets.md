# Spec: Budgets

- Status: living spec (source of truth for behaviour)
- Origin: [founding design](2026-11-08-budgedino-design.md) §8. **[owner]** = decided by the owner,
  **[call]** = AI's call, may be challenged.

- A budget = category (or group of categories) + amount + period (`weekly` ISO Mon–Sun, or `monthly`
  calendar). **[owner]**
- Budgets belong to the household. Each account has a **"counts toward household budgets"** flag
  (`countsTowardBudgets`), independent of visibility; default on for `household` accounts, off for
  `owner-only` accounts. Budgets are computed once per household, so every member sees the same
  numbers. **[owner]**
- Periods are evaluated in the household timezone (default `Europe/Berlin`); base currency EUR by
  default. **[call]**
- No rollover in v1; history of past periods is kept and viewable. **[call]**
- Notification at 80% and 100% usage (configurable), delivered per [security.md](security.md)
  (notifications, no push service in v1). **[call]**

## Computation (implemented in `src/server/src/budgets`)

- **Spent** = −Σ(amounts) of the matching transactions in the budget's categories, over **all** household
  accounts with `countsTowardBudgets`, regardless of who asks and of visibility, booked **and** pending,
  excluding transactions with a `transfer_group_id`. Inflows in a budget category (refunds) therefore
  reduce spent; the raw value may be negative. A refund is never income.
- The API returns raw `spent` (Money) plus `ratio = max(0, spent) / amount` as a 4-decimal string
  (`"0.6800"`), and `fxMissing`.
- **Splits:** a transaction with splits contributes only its split parts, each by its own category; the
  parent category is ignored.
- **Periods:** `weekly` = ISO Mon–Sun, `monthly` = calendar month in the household timezone; booking dates
  are compared as local dates (`from` inclusive, `to` exclusive). No rollover.
- **FX:** non-base-currency amounts are converted at the ECB reference rate of the booking date or the
  latest earlier one (`fx_rates`, refreshed daily by the `fx.refresh` job from the ECB 90-day XML; the
  source is injected, `EcbFxSource` in production). Rates stay decimal strings; conversion is exact
  integer arithmetic with banker's (half-even) rounding to minor units; non-EUR bases use cross rates.
  A transaction without a rate on or before its date is **excluded** and the budget carries
  `fxMissing: true` (never an error, never a guess).
- **API:** `GET /budgets` (member; current period), `POST/PATCH/DELETE /budgets` (admin; DELETE archives).
  `categoryIds` must belong to the household and be neither income nor transfer, `amount` must be positive
  and in the household base currency (else 422). The amount is stored encrypted; the name is plaintext.
- **Home** (`GET /home?period=current|previous|<key>`, member): budgets (household-wide, identical for
  every member), a **breakdown** over the viewer's _visible_ accounts only (spending categories, transfers
  and income excluded, refunds netted, largest first; rows with net spent <= 0 omitted; uncategorized positive
  amounts excluded; each row carries the category's raw stored `icon`/`color`, null for uncategorized) plus
  `daily` (the entries of exactly the categories shown in the breakdown, bucketed by booking day in the household timezone, one `{date, spent}` per day
  from the period start through `min(today, last day)`, zeros included, base currency, refunds kept as
  negative day sums; bookings dated after today count on today; entries without an FX rate are left out and set `fxMissing`; it sums to the
  breakdown total), plus `income` and `uncategorizedIncome` separately, and `sync` (own connectors
  in full, others' only when they back household-visible accounts). The headline period is monthly for
  `current`/`previous` and of the key's kind for `2026-11` / `2026-W46`; budgets of the other kind are
  evaluated for their own period at that moment (each budget view carries its `period`). An
  `owner_only` account that counts toward budgets moves everyone's budget totals but never appears in
  another member's breakdown.

## Statistics

`GET /statistics?months=6|12` (member, default 6; anything else is 400). Over the viewer's _visible_
accounts only, in the household timezone and base currency, classified by the same rules as the home
breakdown (`classifySpend`: transfers skipped; income categories and uncategorized positive amounts are
income; the rest is spending; transfer-grouped transactions excluded; splits expand to their parts).

- `months`: the current month plus the N−1 before it, oldest first, each `{key, start, end, partial,
income, spending}` (`start`/`end` as in `period`: ISO instants, start inclusive, end exclusive).
  The current month is `partial`, and so is the month of the viewer's first visible booking unless that
  booking is dated the 1st (the month is incomplete). Months before the month of the viewer's first visible transaction
  (earliest booking date on visible accounts, any category) are omitted; no visible transaction means
  `months: []`.
- `spending` of a month = sum of the net spend of its spending categories whose net is > 0 (the home
  breakdown rule per month, so it equals the breakdown total of `/home?period=YYYY-MM`). `income` =
  income categories + uncategorized positive amounts (home `income + uncategorizedIncome`).
- `averageKept` = mean of `income − spending` over the complete (non-partial) months in `months`, integer
  minor units rounded half away from zero; `null` when there is none.
- `categories`: net spend per category over the whole window including the current month (`spent`, what
  the list shows), negative nets reported as 0. The trend compares complete months only: `trendSpent` is
  the net spend over the window's complete (non-partial) months, `previousSpent` the net spend over the same
  number K of complete months immediately before the first complete window month. `previousSpent` is `null`
  when K = 0 or when any of those K months lies before the first complete month (incomplete history means no
  trend). Entries with `spent` 0 and `previousSpent` null or 0 are dropped; sorted by `spent` descending,
  then name. Carries the raw `icon`/`color` like the breakdown.
- Entries without an FX rate are left out and set `fxMissing`. Nothing is logged from the result.

## Alerts and notification polling

- After each ingest (after categorization and transfer detection) the household's budgets are evaluated
  for the **current** period. Reaching 80% / 100% of the amount creates one `budget_threshold`
  notification per active member, per budget, per threshold, per period key. Idempotency is a unique
  `(member_id, dedup_key)` index with `dedup_key = budget:<budgetId>:<periodKey>:<threshold>`; refunds
  that dip below a threshold and cross it again in the same period do not notify twice.
- Body: `"<budget name> reached 80%"` — budget names are plaintext by design; **no amounts, no
  transactions**, so nothing from an `owner_only` account can leak. Both thresholds notify when one ingest
  jumps past both.
- `GET /notifications?since=<cursor>&limit<=100` returns the caller's own pending (not yet acknowledged)
  notifications, oldest first, with an opaque keyset cursor (`nextCursor`; unchanged when nothing new).
  `POST /notifications/ack {ids}` marks the caller's own ids delivered; other ids are ignored silently.

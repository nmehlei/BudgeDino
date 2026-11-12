# Spec: Net worth

- Status: living spec (source of truth for behaviour)
- Origin: [founding design](2026-11-08-budgedino-design.md) §9. **[owner]** = decided by the owner,
  **[call]** = AI's call, may be challenged.

- Sources: bank accounts (balances), depots (holdings valued by the connector-reported market value),
  experimental brokers, optional manual assets. **[owner]** / **[call]**
- Daily snapshot per source → history graph stacked by source; list of sources with current value
  and freshness. **[owner]**
- Multi-currency: values stored in original currency and converted to the household base currency
  (EUR default) using ECB reference rates (free). **[call]**

## Simple net worth (implementation summary, P5 preview)

Code: `src/server/src/net-worth/routes.ts`; schema in `src/shared/src/api/net-worth.ts`. History, snapshots and the
graph are P5; this is the current-value view only.

- **`GET /net-worth`** (member): over the caller's visible accounts (`visibleAccountIds`: household accounts plus their
  own, so another member's `owner_only` account never appears). Disconnected accounts (connection removed with "keep
  history") are included; they keep their last known balance.
- **Data used:** the latest balance each sync stored on the account (`accounts.balance_enc` / `balance_at`; the FinTS
  connector reports the closing balance of the statement response). An account that never reported one is listed with
  `balance: null` and left out of every total. No history yet.
- **Response:** `{baseCurrency, total, fxMissing, groups}`. `groups` are the accounts grouped by `kind` in the fixed order
  checking, savings, credit_card, depot, other (empty groups omitted), each `{kind, total, fxMissing, accounts}` with the
  accounts ordered by name. Every account carries `balance` (`{minor, currency}`, decimal-string minor units),
  `baseBalance` (the same value in the household base currency, EUR by default) and `balanceAt`.
- **Conversion [call]:** ECB reference rates, the rate of today or the latest earlier one, exact integer arithmetic with
  one half-even rounding, as for budgets. An account whose currency has no rate gets `baseBalance: null`, is left out of
  the totals and sets `fxMissing` on its group and on the response; the totals then cover only convertible accounts.
- **Totals** are the sum of the converted balances; a credit card with a negative balance reduces them. Group totals add up to
  the overall total.

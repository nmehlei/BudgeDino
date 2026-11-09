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

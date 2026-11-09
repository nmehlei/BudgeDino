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

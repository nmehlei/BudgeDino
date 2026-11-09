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

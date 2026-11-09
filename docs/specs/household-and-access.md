# Spec: Household and access

- Status: living spec (source of truth for behaviour)
- Origin: [founding design](2026-11-08-budgedino-design.md) §3. **[owner]** = decided by the owner,
  **[call]** = AI's call, may be challenged.

## Model

- A **household** has **members** who join by invitation only (no open registration). **[call]**
- Members have personal accounts and share joint accounts. **[owner]**
- Each account has a **visibility** setting: `household` (default) or `owner-only`. Toggleable in the app
  in v1. **[owner]** Visibility is enforced on the server; hidden data never leaves the server to other
  members. **[call]**
- Roles: `admin` (manages members, invites, budgets, categories, shared rules) and `member`. **[call]**
- **Connectors belong to the member who creates them.** Each member connects their own banks with
  their own credentials on their own phone; TAN confirmations, consent-renewal and sync-failure
  notifications go to that member. Joint accounts are connected by one member and shared via
  visibility. **[call]**
- Admins are **not** exempt from visibility: an `owner-only` account is invisible to everyone but its
  owner, admins included. **[call]**

## Related

- Budget inclusion of accounts (`countsTowardBudgets`): [budgets.md](budgets.md)
- Authentication and sessions: [security.md](security.md)

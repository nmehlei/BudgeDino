# Specs

Living specs per area. They are the **source of truth for behaviour**. Every behavioural change
updates the relevant spec in the same PR, before the code (spec → failing test → code → spec updated).

| Area                           | Spec                                               |
| ------------------------------ | -------------------------------------------------- |
| Household, members, visibility | [household-and-access.md](household-and-access.md) |
| Connectors, sync, challenges   | [sync-and-connectors.md](sync-and-connectors.md)   |
| Categorization                 | [categorization.md](categorization.md)             |
| Budgets                        | [budgets.md](budgets.md)                           |
| Net worth                      | [net-worth.md](net-worth.md)                       |
| Mobile app, onboarding         | [mobile.md](mobile.md)                             |
| Security and encryption        | [security.md](security.md)                         |
| Self-hosting and deployment    | [self-hosting.md](self-hosting.md)                 |

Cross-cutting: [architecture, stack, testing, versioning](../architecture.md). Decisions:
[docs/adr](../adr/). Origin: [founding design](2026-11-08-budgedino-design.md) (intent, goals,
screens, open items).

Markers: **[owner]** = decided by the owner; **[call]** = the AI's call, may be challenged.
Specs land through PRs like code.

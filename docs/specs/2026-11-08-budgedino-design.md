# BudgeDino — Founding Design

- Status: Approved by owner (2026-11-09)
- Date: 2026-11-08
- Origin: brainstorming session between the owner and Claude

This document is the founding design. After approval it is split into living per-area specs under
`docs/specs/` (see [spec index](README.md)) and decision records under `docs/adr/`. The moved
sections below are replaced by links; the area specs are the source of truth. Items marked **[owner]** were decided
by the owner; items marked **[call]** are the AI's call and may be challenged.

## 1. Intent and why

The owner and their wife Jess keep asking themselves *where all our money goes*. Earlier attempts at an
overview (spreadsheets, apps) failed because they needed manual steps that stopped being done.

BudgeDino is an open-source, self-hostable household finance app that answers that question
**without recurring manual work**: it pulls accounts, transactions and depot holdings from the banks
and brokers automatically, categorizes transactions, and shows them against household budgets.

**Success:** the owner and Jess open the app and immediately see how far each budget is used this
week/month and where the money went, and that view is correct and current without them having done
anything since the last time.

## 2. Goals, non-goals, anti-goals

### Goals (v1)
- Automatic scheduled and on-demand sync of accounts, transactions and holdings for DKB, C24,
  Revolut, Comdirect, Trade Republic, Scalable Capital. **[owner]**
- Automatic categorization that learns from corrections.
- Household with invited members; budgets per category per week or month. **[owner]**
- Home screen: budget progress and spending breakdown. **[owner]**
- Separate net-worth view: historical graph split by source, plus list of all sources. **[owner]**
- Per-account visibility toggles from the start; default fully transparent. **[owner]**
- Strong encryption; self-hostable; open source; no licensing costs. **[owner]**
- Android app from the start. **[owner]**
- Strong unit and end-to-end testing. **[owner]**
- Spec-driven development with persistent documented context. **[owner]**

### Non-goals (v1)
- iOS app (later; the stack must not prevent it). **[owner]**
- Initiating payments/transfers. Read-only access to banks. **[call]**
- Web UI for end users. **[call]** (the stack must allow adding one later)
- Sending financial data to external AI/LLM services. **[call]**
- Multi-household tenancy per server beyond what falls out naturally (one server may host several
  households, but no SaaS features like billing). **[call]**
- Tax reporting, investment performance analytics (IRR etc.).

### Anti-goals (failure even if it technically works)
- Any **routine** manual step (CSV imports, typing transactions, recategorizing most transactions).
  The only accepted manual steps are bank-mandated consent renewals and occasional corrections.
- Sensitive data readable from a stolen database dump, backup, disk, logs or telemetry.
- Licensing costs or a mandatory paid third party for self-hosters.
- Silent staleness: data that is out of date without the app saying so.

## 3. Household and access model

Superseded by the area specs: moved to [household-and-access.md](household-and-access.md).

## 4. Screens (Android)

1. **Home**: budget progress per category for the current period (e.g. "Groceries €340 / €500,
   this month"), and a breakdown of where money went (by category, drillable into transactions).
   **[owner]** Shows sync freshness and any connector needing attention. **[call]**
2. **Transactions**: list, search, filter; recategorize; split a transaction across categories. **[call]**
3. **Budgets**: create/edit per category, period weekly or monthly. **[owner]**
4. **Net worth** (not on home): history graph stacked by source, list of sources (bank accounts, depots,
   etc.) with current value. **[owner]**
5. **Connections**: add/repair connectors, consent-expiry status, "sync now". **[call]**
6. **Household & settings**: members, invites, account visibility, categories, rules, app lock. **[call]**

## 5. Data sources and connectors

Superseded by the area specs: moved to [sync-and-connectors.md](sync-and-connectors.md).

## 6. Sync

Superseded by the area specs: moved to [sync-and-connectors.md](sync-and-connectors.md).

## 7. Categorization

Superseded by the area specs: moved to [categorization.md](categorization.md).

## 8. Budgets

Superseded by the area specs: moved to [budgets.md](budgets.md).

## 9. Net worth

Superseded by the area specs: moved to [net-worth.md](net-worth.md).

## 10. Security and encryption

Superseded by the area specs: moved to [security.md](security.md).

## 11. Architecture and stack

Superseded by the area specs: moved to [../architecture.md](../architecture.md).

## 12. Self-hosting and deployment

Superseded by the area specs: moved to [self-hosting.md](self-hosting.md).

## 13. Testing strategy

Superseded by the area specs: moved to [../architecture.md](../architecture.md).

## 14. Versioning

Superseded by the area specs: moved to [../architecture.md](../architecture.md).

## 15. Spec-driven development **[owner]**

Superseded by the area specs: moved to [README.md](README.md).

## 16. Left to the builder

- Exact API shape, DB schema, UI layout and visual design (follow the screens in §4).
- Scalable Capital connector approach (research first; document in an ADR).
- Trade Republic protocol port details.
- Category default list details and merchant heuristics.
- Order of implementation, as long as the first milestone delivers an end-to-end slice:
  one real connector → transactions → categories → one budget on the home screen.

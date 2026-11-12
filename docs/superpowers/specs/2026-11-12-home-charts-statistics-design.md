# Home charts, category icons and Statistics tab — design

Status: draft for owner approval (2026-11-12). Mockups: `.superpowers/brainstorm/80121-1794495003/content/home-layouts.html` (owner picked option **B**).

## Why

Owner feedback on the dev build: Home shows budgets and spending as two separate lists, so "it's hard to see as a human what refers to what"; the screen should have "beautiful gorgeous graphs"; every category "needs to have an icon that should look great and quickly identifies the categories"; there should be a Statistics tab (contents: best guess for now, refined later).

The question Home must answer at a glance is **"am I on track this month?"** (owner chose the pace-chart direction over a donut or icon rings).

## Goals

1. **Home (option B):** one screen, one list.
   - Header as today: `‹ November 2026 ›`, below it "19 days left · ✓ synced" on one line (the separate sync chip shrinks into this line; problems still show the full status bar/banner as today).
   - Headline: total spent so far (large), and one comparison line, e.g. "↓ 58 € less than by this day last month" (green when less, amber when more; hidden when there is no previous-period data).
   - **Pace chart:** cumulative spending per day for the period (solid accent line with a soft gradient fill, a dot at today) against the previous period's cumulative line (dashed, grey). X axis: first day, "today", last day. Two light gridlines with labels. Legend: "this month" / previous month name. When viewing the previous period, the dashed line is the period before it, and there is no "today" dot.
   - **One category list** below the chart, replacing the separate Budgets and Spending sections. Each row: category icon (tinted circle), name, amount. Categories that have a budget show "spent / budget" and a bar with a **pace marker** (thin vertical tick at the fraction of the budget's own period elapsed; weekly budgets use the week). Bar colour by level as today (ok/warn/over); "Over by X" in the error colour when over. Budgeted categories first (by budget name), then the rest by amount, largest first. A weekly budget row shows a small "week" label and its week numbers; the row's monthly total is not shown separately (keep it simple).
   - Every row is tappable and opens the transactions drill-down (existing `openCategory` params). A budget that spans several categories shows as a budget row with its categories as indented sub-rows (see "Settled" item 3).
   - Income: one quiet line under the headline ("Income 2.450,00 €"), not in the list.
2. **Category icons and colours** everywhere a category appears: Home list, transactions list rows, transaction detail, drill-down header, categories management, category picker, Statistics.
3. **Statistics tab** (new, between Transactions and Connections; icon `chart-box-outline`), v1 best guess as in the mockup:
   - Toggle 6 months / 12 months.
   - Grouped bars per month: income (accent) vs spending (orange); current month drawn at reduced opacity and labelled as partial.
   - One line: "You kept on average X a month" (income − spending, complete months only; negative wording when spending exceeded income).
   - Top categories over the window (top 5, then "Show all"), each with icon, total, a share bar, and trend vs the equally long window before it (▲/▼ %; ▲ in amber for spending growth, ▼ green). No trend when the earlier window has no data.
   - Tapping a month bar opens Transactions filtered to that month; tapping a category opens the drill-down for the window.

## Non-goals

- No rollover, forecasting, savings goals, or net-worth charts on Statistics in v1.
- No user-uploaded icons; icons come from a fixed curated set.
- No new chart library: charts are drawn with `react-native-svg` (already installed), so no native rebuild is needed.
- No change to budget semantics or to what counts as spending (same rules as today's breakdown: transfers excluded, income categories and uncategorised positive amounts count as income).

## Anti-goals

- Charts must never show floats-derived money: all sums in integer minor units on the server; the client only scales numbers to pixels.
- No amounts in logs/traces for the new endpoints (existing rule).
- No category colour that is unreadable in dark mode or indistinguishable from its neighbour; amounts are never conveyed by colour alone (labels/values always present).

## Constraints

- Money in minor units + ISO 4217; base currency conversion via the existing FX converter; `fxMissing` propagated as today.
- Visibility: every new number comes from the viewer's visible accounts (`visibleAccountIds`), exactly like today's breakdown. Budgets stay household-wide.
- Household timezone for day/month boundaries.
- New GET route(s): `config.access: 'member'`, entries in `tests/support/route-fixtures.ts` as needed, pass the visibility harness; `pnpm openapi` regenerated.
- Specs updated in the same commits: `docs/specs/budgets.md` (home response), `categorization.md` (icon/colour), `mobile.md` (Home, Statistics), plus API docs.
- Light and dark themes; font scale 2 wraps without clipping; charts have an `accessibilityLabel` summarising them in words.

## Decided parts of the how

### Server

- **`GET /home` gains `daily`:** spending per calendar day of the period, `[{ date: 'YYYY-MM-DD', spent: moneyJson }]`, one entry per day from period start to `min(today, end)`, zeros included, in base currency, same inclusion rules as `breakdown`. Additive; existing fields unchanged. The client cumulates. The comparison line uses the previous period's `daily` (the app fetches `period=previous`, or the explicit key of the period before when viewing previous).
  - "By this day last month" compares cumulative spending up to the same day-of-period index (day 12 vs day 12; if the previous month is shorter, clamp to its last day).
- **`GET /statistics?months=6|12`** (member): for the last N months including the current partial one, returns `months: [{ key: 'YYYY-MM', start, end, partial: boolean, income, spending }]` and `categories: [{ categoryId|null, name, spent, previousSpent }]` where `spent` is over the N-month window and `previousSpent` over the N months before it; `fxMissing`. Implemented by reusing the breakdown logic per month (one decryption pass over the 2N-month range is preferred over 2N separate queries — builder's call). Category entries also carry `icon` and `color`.
- **Categories get `icon` and `color`:** new nullable columns via a migration (next number after `0012`). `icon` is an MDI glyph name from a curated allowlist in `@budgedino/shared` (~40 icons); `color` is a key from a fixed palette in `@budgedino/shared` (~16 keys such as `green`, `orange`, `blue`, `violet`, `rose`, `amber`, `teal`, `brown`, `slate`, …), each with a light and a dark hex. Storing keys, not hex, keeps dark mode right.
  - Defaults for the 19 seeded categories (bootstrap seeds them; the migration backfills existing households by matching the default names):
    groceries `cart`/green · eating-out `silverware-fork-knife`/orange · transport `bus`/blue · housing `home-variant`/brown · utilities `lightning-bolt`/amber · insurance `shield-check`/indigo · subscriptions `play-box-multiple`/violet · shopping `shopping`/pink · health `heart-pulse`/rose · kids `teddy-bear`/apricot · leisure `ticket`/teal · travel `airplane`/sky · gifts-donations `gift`/red · fees `receipt-text`/slate · cash `cash`/olive · savings-investments `piggy-bank`/gold · income `cash-plus`/accent · transfer `swap-horizontal`/grey · uncategorized `help`/grey.
  - Categories with null icon/colour (custom ones created before this change) render with `tag` and a colour derived deterministically from the category id.
  - `POST/PATCH /categories` accept optional `icon` and `color` (validated against the allowlists); every response carrying a category (`categoryInfo`, `/home` breakdown and budgets, transaction category refs, `/statistics`) includes `icon` and `color`.

### Mobile

- Charts are hand-drawn components on `react-native-svg`: `PaceChart` (Home), `MonthBars` (Statistics). Pure geometry helpers (scaling, cumulative sums, path building) live in testable modules separate from rendering.
- A shared `CategoryIcon` component (tinted circle with the glyph, size variants) and a palette hook resolving colour keys for the current theme.
- Categories management: create/edit gets an icon picker (grid of the allowlist) and a colour picker (swatches).
- Statistics is a new tab route; data via React Query like Home, pull-to-refresh, loading/error/empty states in the Home style. Empty state when there are fewer than one complete month of data: "Statistics appear after your first full month."
- Carry the two open review items from the previous round: make `security.test.tsx` independent of the previous test's module flag, and pin the clock in the Home "days left" test.

## Settled after the builder check (designer's calls, owner may override)

1. **Period kind.** The app's Home only uses `current`/`previous`, which are monthly (`src/server/src/home/routes.ts:43`). `daily` and the chart are written for any period kind (generic "previous period" wording internally). The UI copy says "month" because Home is monthly.
2. **Stable category identity.** The same migration (0013) adds a nullable `key` column to `categories`. Bootstrap sets it for the 19 defaults. The migration backfills `key`, `icon` and `color` for existing households by exact match on the English default name, and only where the household has exactly one category with that name. Renamed or ambiguous defaults stay null and render with the `tag` fallback; the owner can pick an icon in the editor. `key` is internal: it is not editable and not shown.
3. **Budgets with several categories** (`budgets.categoryIds` is an array). The budget row shows the budget name, its bar and the first category's icon. Each covered category appears as an indented sub-row under it, with its icon and amount, and is tappable (the drill-down takes one `categoryId`, `src/shared/src/api/transactions.ts:43`). A single-category budget is a single tappable row, as in the mockup. This sub-row layout also answers the owner's "what refers to what".
4. **"The rest"** means categories covered by no budget. A category covered by two budgets appears under each of them. Its amount is not double-counted in the headline, which sums `breakdown`.
5. **Income line.** It shows `income` as today. "Uncategorised income X" stays as a separate quiet line when non-zero (current behaviour in `HomeSummary.tsx:65`).
6. **Statistics empty state and range.** A month counts from the first visible transaction's month. Earlier months in the window are omitted, not drawn as zero bars. The empty state shows while there is no complete month.
7. **Month-bar tap.** It uses the existing `from`/`to` filter on `/transactions` (`src/shared/src/api/transactions.ts:40`). The Transactions screen gets a matching date-range filter chip if it doesn't have one yet.
8. **Where icon and colour travel.** `categoryInfo` (the `/categories` API), the `/home` breakdown and budgets, and `/statistics` include `icon`/`color`. Transaction rows resolve them on the client from the cached categories list, so the transaction DTOs stay unchanged.

## Left to the builder

- Exact curated icon list beyond the 19 defaults, and the exact palette hex values (must pass WCAG non-text contrast 3:1 against surface in both themes).
- Chart sizing, gridline values ("nice" round numbers), animation (a single short draw-in on first load is fine; respect reduce motion).
- Query/caching shape on the server for `/statistics`.
- Whether the weekly budget row needs more than the "week" label.

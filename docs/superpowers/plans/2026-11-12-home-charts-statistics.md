# Home Charts, Category Icons and Statistics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every category gets an icon and colour. Home becomes "am I on track?": a pace chart plus one combined budget-and-category list. A new Statistics tab shows monthly income vs spending and top categories.

**Architecture:**

- **Server (3 tasks):** category `key`/`icon`/`color` (migration 0013 plus shared allowlists); `daily` on `GET /home`; a new `GET /statistics`.
- **Mobile (4 tasks):** `CategoryIcon` with icon and colour pickers; chart geometry plus `PaceChart`/`MonthBars` on `react-native-svg` (already installed, so no native rebuild); the Home rework; the Statistics tab.

**Tech Stack:** Fastify + zod + Drizzle (drizzle-kit migrations in `src/server/drizzle`), Vitest + Testcontainers; Expo Router, react-native-paper MD3, TanStack Query, react-native-svg 15, jest-expo + RNTL 14.

**Spec:** `docs/superpowers/specs/2026-11-12-home-charts-statistics-design.md` (approved 2026-11-12). Living specs to update: `docs/specs/categorization.md`, `docs/specs/budgets.md`, `docs/specs/mobile.md`. Decisions not in the design are marked **[call]**.

## Global Constraints

- Money in integer minor units + ISO 4217; sums on the server (bigint); the client only maps numbers to pixels (`Number(minor)` allowed **only** for geometry, never for displayed text).
- New numbers come from the viewer's visible accounts (`visibleAccountIds`); budgets stay household-wide. Same inclusion rules as today's `breakdownFor` (transfers excluded; income categories and uncategorised positive amounts are income).
- Household timezone for day/month boundaries.
- Every route declares `config.access`. New GET routes pass the visibility harness (`tests/server/access/visibility.int.test.ts`) and get `tests/support/route-fixtures.ts` entries if they have path params. `pnpm openapi` is regenerated and committed.
- Logs and traces never contain amounts or category spend.
- Specs are updated in the same commit as the behaviour.
- Mobile:
  - RNTL 14 `await render` / `await fireEvent`;
  - colours from the theme or the category palette hook only;
  - wraps at font scale 2;
  - light and dark themes;
  - charts carry an `accessibilityLabel` that summarises them in words;
  - one short draw-in animation at most, skipped when reduce motion is on.
- Conventional commits, **no AI attribution**. Run `SKIP_INTEGRATION=1 bash ci/check.sh` before each commit, and the task's integration tests where Docker is available. No `cd <dir> &&` chains, no bare `git stash`, no emulator.

## Decisions [call]

- **C1 Palette:** `CATEGORY_COLORS` in `@budgedino/shared` holds 18 keys, each `{ light, dark }` hex:
  - `green`, `orange`, `blue`, `brown`, `amber`, `indigo`, `violet`, `pink`, `rose`, `apricot`, `teal`, `sky`, `red`, `slate`, `olive`, `gold`, `accent`, `grey`.
  - Light values start from the mockup: green `#2F9E6B`, orange `#E07A3F`, blue `#3E7BD6`, brown `#7A5C4A`, amber `#B8860B`, indigo `#4A6FA5`, violet `#8A5CD0`, pink `#C2489A`, rose `#D6456B`, apricot `#D07A20`, teal `#1F9BAA`, sky `#2D8FD5`, red `#D04848`, slate `#6B7A8F`, olive `#5E8C3A`, gold `#B7861A`, accent `#2E7D6B`, grey `#7D8784`.
  - Dark values are lighter tints. Each value must reach 3:1 against the theme surface (`#FBFDFB` light, `#151B18` dark); a unit test checks this.
- **C2 Icons:** `CATEGORY_ICONS` is a readonly tuple of 40 MaterialCommunityIcons names. It includes the 19 defaults (design doc) plus `tag` (fallback), `dog`, `school`, `dumbbell`, `car`, `gas-station`, `phone`, `wifi`, `tshirt-crew`, `hammer-wrench`, `flower`, `baby-carriage`, `glass-cocktail`, `coffee`, `book-open-variant`, `music`, `gamepad-variant`, `briefcase`, `hospital-box`, `bank`, `credit-card`. A test checks that each name exists in `MaterialCommunityIcons.glyphMap`.
- **C3 Defaults:** `DEFAULT_CATEGORIES` entries gain `icon` and `color`; the mapping is taken verbatim from the design doc.
- **C4 Fallback:** `fallbackCategoryStyle(id)` returns `{ icon: 'tag', color }`, where `color` is `CATEGORY_COLOR_KEYS[fnv1a(id) % (len - 2)]` (`accent` and `grey` are excluded). It is deterministic.
- **C5 Budgets in `/home`:** `budgetView` is unchanged. The app resolves a budget's icon from the categories list it already caches. Only `breakdown` entries gain `icon`/`color`. (This narrows the design doc's "and budgets": the app needs nothing more.)
- **C6 Comparison:** cumulative spending up to day index `d` (1-based, today's day of the period) against the previous period's cumulative sum up to `min(d, its length)`. The line is hidden when the previous period's `daily` sums to zero.
- **C7 Statistics window:** `months` is 6 or 12, default 6. It covers the current month plus the N−1 months before it. Months before the month of the viewer's first visible transaction are omitted; that first month is `partial` unless its first booking is on the 1st. `averageKept` is the mean over complete (non-partial) months; it is null when there are none. Category entries carry `spent` (whole window), `trendSpent` (the window's complete months) and `previousSpent` (the same number of complete months before them; null when that history is incomplete). Entries with `spent == 0` and `previousSpent` null or 0 are dropped. Sorting is by `spent` descending, then by name.

## Review Focus

1. **A household whose defaults were renamed or duplicated before the migration.** No crash and no wrong icon: ambiguous names stay null and render with the `tag` fallback (Task 1 migration test).
2. **The 1st of the month, before any spending.** `daily` has one zero entry and the chart draws a flat start with no NaN path. The comparison line is hidden when last month is empty too (Tasks 2, 5, 6).
3. **A previous month that is shorter (31 Mar → Feb).** The day index clamps and the dashed line ends at its last day (Tasks 2, 5).
4. **A brand-new household (no transactions).** `/statistics` returns `months: []` and `averageKept: null`, and the tab shows the empty state, not an error (Tasks 3, 7).
5. **All spending in a currency without an FX rate.** `fxMissing: true` is shown as today's notice; the charts still render the converted part (Tasks 2, 3, 6, 7).

---

### Task 1: Category key, icon and colour (shared + server)

**Files:**

- Create: `src/shared/src/category-style.ts` (exported from `src/shared/src/index.ts`)
- Modify:
  - `src/server/src/categorization/defaults.ts` (`icon`, `color` per default);
  - `src/server/src/db/schema.ts` (`categories.key`, `icon`, `color`, all nullable text, plus a partial unique index on `(household_id, key)` where `key IS NOT NULL`);
  - `src/server/src/households/bootstrap.ts` (seed `key`, `icon`, `color`);
  - `src/shared/src/api/categories.ts` (`categoryInfo` gains `icon: string|null` and `color: string|null`; create/patch accept `icon?` and `color?` validated with `z.enum(CATEGORY_ICONS)` and `z.enum(CATEGORY_COLOR_KEYS)`; `null` in patch clears them);
  - the categories routes in `src/server/src/categorization/routes.ts`;
  - `docs/specs/categorization.md`, `docs/api/openapi.json`.
- Create: `src/server/drizzle/0013_category_style.sql`, generated with drizzle-kit (`pnpm --filter @budgedino/server exec drizzle-kit generate --name category_style`) and then hand-extended with the backfill `UPDATE`.
- Test:
  - `tests/shared/category-style.test.ts` (new);
  - `tests/server/categorization/category-style.int.test.ts` (new);
  - extend the existing categories route int tests.

**Interfaces:**

- Produces (shared):
  - `CATEGORY_COLOR_KEYS: readonly [...]`, `type CategoryColorKey`;
  - `CATEGORY_COLORS: Record<CategoryColorKey, { light: string; dark: string }>`;
  - `CATEGORY_ICONS: readonly [...]`, `type CategoryIcon`;
  - `fallbackCategoryStyle(id: string): { icon: CategoryIcon; color: CategoryColorKey }`;
  - `resolveCategoryStyle(c: { id: string; icon: string | null; color: string | null }): { icon: CategoryIcon; color: CategoryColorKey }` (unknown or null values fall back per field).
- Produces (API): `categoryInfo.icon`, `categoryInfo.color` (nullable strings).

- [ ] **Step 1: Write failing tests.**
  - Shared:
    - `every colour reaches 3:1 against the surface in both themes` (WCAG relative luminance, with a small helper in the test);
    - `fallback is deterministic and never accent/grey`;
    - `resolveCategoryStyle falls back per field for null and unknown values`.
  - Server int:
    - `new households get key, icon and colour for all 19 defaults` (spot-check groceries → `cart`/`green` and transfer → `swap-horizontal`/`grey`);
    - `migration backfill`: run migrations up to 0012, insert a household with the default names, one renamed (`Lebensmittel` instead of Groceries) and one duplicated (two `Cash`). Apply 0013. Groceries stays null (renamed), both Cash rows stay null (ambiguous), Eating out gets `silverware-fork-knife`/`orange`. Use the migration test helper the repo already has if one exists; otherwise apply the SQL file in a Testcontainers DB.
    - `POST /categories with icon/color stores them; invalid icon → 400; PATCH color null clears it; key is never accepted from the client`.
- [ ] **Step 2: Run** `pnpm vitest run tests/shared/category-style.test.ts` and `pnpm vitest run --project integration tests/server/categorization/category-style.int.test.ts` → FAIL.
- [ ] **Step 3: Implement** the shared module, the schema, the generated migration plus the backfill.
  - The backfill is one `UPDATE categories c SET key=v.key, icon=v.icon, color=v.color FROM (VALUES …19 rows…) v(name,key,icon,color) WHERE c.name = v.name AND c.key IS NULL AND (SELECT count(*) FROM categories d WHERE d.household_id = c.household_id AND d.name = c.name) = 1`.
  - Then bootstrap, the schemas and the routes. Every route that returns `categoryInfo` maps the new columns.
- [ ] **Step 4: Update** `docs/specs/categorization.md` (a section "Icon and colour": allowlists, defaults table, fallback, internal `key`). Run `pnpm openapi`.
- [ ] **Step 5: Run** the new tests and `SKIP_INTEGRATION=1 bash ci/check.sh` → PASS.
- [ ] **Step 6: Commit** `feat(server): category icons and colours`.

### Task 2: Daily spending on `GET /home` (server)

**Files:**

- Modify:
  - `src/server/src/budgets/service.ts`: `breakdownFor` also returns `daily`, and each breakdown entry gets the category's `icon`/`color` (null for uncategorised);
  - `src/server/src/home/routes.ts`;
  - `src/shared/src/api/budgets.ts`: `homeResponse.daily` and the breakdown entry fields;
  - `docs/specs/budgets.md` (the Home section);
  - `docs/api/openapi.json`.
- Test: extend the existing `/home` integration test file (find it with `grep -rl "'/home'" tests/server`).

**Interfaces:**

- Produces:
  - `homeResponse.daily: Array<{ date: string /* YYYY-MM-DD, household tz */; spent: { minor: string; currency: string } }>`, one entry per day from the period start through `min(today, last day of period)`, zeros included, in the base currency;
  - `homeResponse.breakdown[i].icon: string | null`, `.color: string | null`.

- [ ] **Step 1: Write failing tests.**
  - `daily has one entry per elapsed day with zeros, and sums to the breakdown total`. Fake clock on 12 Nov 2026 with spending on 1, 3 and 12 Nov: 12 entries, and the sum equals the sum of `breakdown[].spent`.
  - `previous period daily covers the whole month`. With `period=previous` on 12 Nov: 31 entries (October).
  - `a booking at 23:30 Berlin on the last day of a month lands on that day` (tz boundary).
  - `transfers and income are not in daily`.
  - `foreign currency without an FX rate is left out of daily and sets fxMissing`.
  - `breakdown entries carry icon and colour; uncategorised has nulls`.
- [ ] **Step 2: Run** the file with `pnpm vitest run --project integration <file>` → FAIL.
- [ ] **Step 3: Implement.** In the same loop that builds `spending`, bucket each spending entry by its booking date in the household timezone (`entries` already carry the booking date). Convert per day with the same `spentOf` helper. Negative day sums (refunds) are kept as they are; the client clamps the cumulative line at 0.
- [ ] **Step 4: Update** `docs/specs/budgets.md` and `pnpm openapi`. Run the tests and `SKIP_INTEGRATION=1 bash ci/check.sh` → PASS.
- [ ] **Step 5: Commit** `feat(server): daily spending series on home`.

### Task 3: `GET /statistics` (server)

**Files:**

- Create: `src/server/src/statistics/routes.ts` (registered in `src/server/src/app.ts` next to `homeRoutes`), `src/shared/src/api/statistics.ts` (exported from the shared index)
- Modify:
  - `src/server/src/budgets/service.ts`: extract the per-entry classification from `breakdownFor` into a reusable `classifySpend(entries, cats)` so both use one rule set;
  - `docs/specs/budgets.md` (new "Statistics" section);
  - `docs/api/openapi.json`.
- Test: `tests/server/statistics/statistics.int.test.ts` (new); the visibility harness picks the route up automatically (no path params).

**Interfaces:**

- Produces:
  - `statisticsQuery = z.object({ months: z.coerce.number().pipe(z.union([z.literal(6), z.literal(12)])).default(6) })`;
  - `statisticsResponse`:
    - `months: Array<{ key: 'YYYY-MM'; start; end; partial: boolean; income: moneyJson; spending: moneyJson }>` (oldest first);
    - `averageKept: moneyJson | null`;
    - `categories: Array<{ categoryId: string | null; name; icon: string | null; color: string | null; spent: moneyJson; previousSpent: moneyJson }>`;
    - `fxMissing: boolean`.
  - Types `StatisticsResponse` and `StatisticsQuery`.

- [ ] **Step 1: Write failing tests.**
  - `six months by default, oldest first, current month partial`. On 12 Nov 2026: keys `2026-06` … `2026-11`, and only the last has `partial: true`.
  - `months before the first visible transaction are omitted`.
  - `averageKept uses complete months only`. Income 2,000 / spending 1,500 in Sep and Oct, and anything in Nov: `averageKept.minor === '50000'`.
  - `averageKept is null with no complete month`.
  - `previousSpent covers the six months before the window`.
  - `categories sorted by spent desc and drop all-zero entries`.
  - `invisible accounts never count`: another member's owner-only account spending is excluded.
  - `months=7 → 400`.
  - `empty household → months [] and averageKept null`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
  - Load spend entries once for the 2N-month range (`loadSpendEntries` with `from` = start of the earliest previous-window month).
  - Bucket them by month key in the household timezone and classify with `classifySpend`.
  - Sum with `spentOf` per bucket. Access is `member`.
  - Don't log query results.
- [ ] **Step 4: Update** the spec, `pnpm openapi`, tests, and `SKIP_INTEGRATION=1 bash ci/check.sh` → PASS.
- [ ] **Step 5: Commit** `feat(server): monthly statistics endpoint`.

### Task 4: Category icons in the app (mobile)

**Files:**

- Create:
  - `src/mobile/src/categories/CategoryIcon.tsx`;
  - `src/mobile/src/categories/useCategoryStyle.ts`;
  - `src/mobile/src/categories/StylePicker.tsx` (icon grid + colour swatches).
- Modify:
  - `src/mobile/src/categories/CategoriesScreen.tsx` (create/edit dialog gains the pickers; the list shows icons);
  - `src/mobile/src/transactions/TransactionRow.tsx`, `TransactionDetailScreen.tsx`, the category picker used by the transaction detail and the filter chip menu in `TransactionsScreen.tsx`: show `CategoryIcon`;
  - `docs/specs/mobile.md`.
- Test: `src/mobile/src/categories/__tests__/category-icon.test.tsx` (new); extend the categories and transactions tests.

**Interfaces:**

- Consumes: Task 1 shared exports; `categoryInfo.icon/color`.
- Produces:
  - `useCategoryColor(key: CategoryColorKey): string` (the theme-aware hex);
  - `useCategoryStyleById(): (categoryId: string | null) => { icon: CategoryIcon; color: string }`. It is built from the cached categories query. `null` → `{ icon: 'help', color: grey }`; an id not found → the fallback.
  - `<CategoryIcon icon color size?: 'sm' | 'md' | 'lg' /* 28 | 36 | 44 dp */ accessibilityElementsHidden />`: a circle filled with the colour at 13 % opacity, and the glyph in the colour at 55 % of the size.
  - `<StylePicker value={{ icon, color }} onChange />`.

- [ ] **Step 1: Write failing tests.**
  - `CategoryIcon renders the glyph and tinted background for a key in light and dark`;
  - `useCategoryStyleById resolves stored, fallback and uncategorised`;
  - `creating a category sends icon and color`;
  - `editing a category's colour sends PATCH { color }`;
  - `transaction rows show the category icon`.
- [ ] **Step 2: Run** `pnpm --filter @budgedino/mobile test -- category` → FAIL.
- [ ] **Step 3: Implement.** The picker is a `Dialog` with a 6-column icon grid (each 44 dp, `accessibilityLabel` is the icon name with `-` → space) and an 18-swatch row that wraps; the selected item gets a 2 dp primary outline.
- [ ] **Step 4: Update** `docs/specs/mobile.md`. Run the mobile tests and `SKIP_INTEGRATION=1 bash ci/check.sh` → PASS.
- [ ] **Step 5: Commit** `feat(mobile): category icons and colour picker`.

### Task 5: Chart geometry and `PaceChart` (mobile)

**Files:**

- Create:
  - `src/mobile/src/charts/geometry.ts` (pure);
  - `src/mobile/src/charts/PaceChart.tsx`;
  - `src/mobile/src/charts/useDrawIn.ts` (one-shot animation; respects `AccessibilityInfo.isReduceMotionEnabled`).
- Test: `src/mobile/src/charts/__tests__/geometry.test.ts`, `pace-chart.test.tsx`.

**Interfaces:**

- Produces:
  - `cumulative(daily: Array<{ spent: { minor: string } }>): bigint[]`. It is clamped at 0 per point; refunds can lower the running sum but never below 0.
  - `niceMax(maxMinor: bigint): bigint`. The next value of the form 1/2/5 × 10^k (in minor units, rounded to whole currency units), ≥ max and > 0.
  - `linePath(values: bigint[], dayCount: number, max: bigint, w: number, h: number): string`. An SVG path `M…L…`, where x = i/(dayCount−1)·w. It returns `''` for an empty array, and a horizontal segment from x=0 for a single value.
  - `comparisonAt(current: bigint[], previous: bigint[]): { day: number; current: bigint; previous: bigint } | null` (C6).
  - `<PaceChart current={daily} previous={prevDaily | undefined} dayCount={daysInPeriod} showToday={boolean} currency labels={{ current: 'this month', previous: monthName }} />`:
    - the solid accent line with a gradient fill (`Defs`/`LinearGradient`), the dashed `onSurfaceVariant` previous line, two gridlines with formatted labels (`formatMoney`, no decimals), and x labels (first day, "today", last day);
    - its `accessibilityLabel` reads like "Spent 351 € so far this month; 409 € by this day last month."

- [ ] **Step 1: Write failing geometry tests.** Cumulative clamps a refund that would go below 0. `niceMax(35138n)` → `50000n` and `niceMax(0n)` → `100n`. `linePath` on an empty array, a single point, and a known 3-point case (exact string). `comparisonAt` clamps to the shorter previous period and returns null when previous sums to 0. The 1st of the month gives one zero point and no `NaN` in the path.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.**
- [ ] **Step 4: Write chart render tests:** the paths are present, there is no previous path when `previous` is undefined, there is no today dot when `showToday` is false, and the accessibilityLabel text is correct. Run → PASS.
- [ ] **Step 5: Commit** `feat(mobile): pace chart`.

### Task 6: Home rework, option B (mobile)

**Files:**

- Modify:
  - `src/mobile/src/home/HomeScreen.tsx`;
  - `HomeSummary.tsx` (headline, comparison line, income lines);
  - `PeriodHeader.tsx` (the sub-line "19 days left · ✓ synced");
  - `SyncStatusBar.tsx`: compact when everything is ok; the full bar and banner only for problems.
- Replace: `BudgetRow.tsx` + `SpendingList.tsx` with `CategoryList.tsx` (budget rows, sub-rows, then the rest).
- Modify: `budget-math.ts` (add `elapsedFraction(period: { start: string; end: string }, now: Date): number` clamped to 0..1; `groupForHome(budgets, breakdown): HomeGroup[]`), `docs/specs/mobile.md`.
- Test: `src/mobile/src/home/__tests__/home.test.tsx` (rework), `budget-math.test.ts`.
- Also fix the two open review items: `src/mobile/src/security/__tests__/security.test.tsx` must not depend on the previous test's module flag (reset modules or set the flag explicitly in each test), and the "days left" test in `home.test.tsx` uses `jest.useFakeTimers().setSystemTime(...)`.

**Interfaces:**

- Consumes:
  - Task 2: `daily`, `breakdown[].icon/color`;
  - Task 4: `CategoryIcon`, `useCategoryStyleById`;
  - Task 5: `PaceChart`, `comparisonAt`, `cumulative`.
- Produces: `type HomeGroup = { kind: 'budget'; budget: BudgetView; categories: Array<{ categoryId: string; name: string; spent: Money | null }> } | { kind: 'category'; categoryId: string | null; name: string; spent: Money }`.
  - Budget groups come first, in budget name order.
  - Then the categories covered by no budget, by spent descending.
  - A category in two budgets appears under both.

- [ ] **Step 1: Write failing tests.**
  - `groupForHome`: a single-category budget is one group with that category; a multi-category budget lists its categories; covered categories are not in the rest; a category in two budgets appears under both; an uncategorised entry stays in the rest.
  - `elapsedFraction`: start → 0, middle → about 0.5, after end → 1.
  - Home screen:
    - the headline total is the sum of breakdown;
    - with `previous` data, "↓ 58,00 € less than by this day last month", or the "more" variant in the warning colour;
    - no comparison when previous is empty;
    - a budget row shows "182,40 / 500 €" and the pace tick at `elapsedFraction` (`testID="pace-tick"`, left as a percentage);
    - a multi-category budget shows indented sub-rows, each tappable with the existing `openCategory` params;
    - rest rows are tappable;
    - weekly budgets show the label "week";
    - over budget shows "Over by …" in the error colour;
    - the sync line is compact when ok and the full bar shows on error;
    - the arrows still switch the period;
    - on the previous period the chart has no today dot and its comparison is the period before (`/home?period=<YYYY-MM>`).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
  - The previous series comes from a second `useQuery` keyed by period. For `current` use `period=previous`; for `previous` use the explicit `YYYY-MM` key of the month before. Format the key from `period.start` in the household timezone.
  - Budget rows: `CategoryIcon` of the first category, name (+ "week" label for weekly), "spent / amount", a 6 dp bar with the level colour, and a 2 dp × 12 dp tick in `onSurface` at 55 % opacity.
  - Sub-rows: 16 dp indent, `sm` icon, name, amount, chevron.
  - Layout order: header, headline, PaceChart, list. Spacing as before (16 dp sides, 24 dp between blocks).
- [ ] **Step 4: Update** `docs/specs/mobile.md` (the Home section rewritten). Run the mobile tests and `SKIP_INTEGRATION=1 bash ci/check.sh` → PASS.
- [ ] **Step 5: Commit** `feat(mobile): home pace chart with one combined budget and category list`.

### Task 7: Statistics tab (mobile)

**Files:**

- Create:
  - `src/mobile/app/(app)/statistics.tsx` (route);
  - `src/mobile/src/statistics/StatisticsScreen.tsx`;
  - `src/mobile/src/statistics/queries.ts`;
  - `src/mobile/src/charts/MonthBars.tsx`.
- Modify: `src/mobile/app/(app)/_layout.tsx` (a tab "Statistics", icon `chart-box-outline`, between Transactions and Connections), `docs/specs/mobile.md`.
- Test: `src/mobile/src/statistics/__tests__/statistics.test.tsx`, `src/mobile/src/charts/__tests__/month-bars.test.tsx`.

**Interfaces:**

- Consumes: Task 3 `StatisticsResponse`; Task 4 `CategoryIcon`; Task 5 `niceMax`.
- Produces:
  - `useStatistics(months: 6 | 12)`;
  - `<MonthBars months={StatisticsResponse['months']} onSelectMonth={(m) => void} />`: grouped bars per month, income in accent and spending in the `orange` category colour; the partial month at 45 % opacity with the label suffix "so far"; each group is a `Pressable` with `accessibilityLabel` like "October 2026: income 2.450 €, spending 2.040 €".

- [ ] **Step 1: Write failing tests.**
  - The 6/12 toggle refetches with `months=12`.
  - Bars render one group per month.
  - Tapping a month navigates to Transactions with `from`/`to` = the month's first and last day (local dates, household tz).
  - "You kept on average 410,00 € a month", and "You spent on average X more than you earned" when negative; the line is hidden when `averageKept` is null.
  - Top categories: the top 5 are shown, then "Show all" expands; the trend reads "▲ 8 %" in the warning colour for a rise and "▼ 12 %" in primary for a fall; there is no trend when `previousSpent` is 0. Percentages are computed with bigint (`(spent − prev) * 100n / prev`, rounded half away from zero).
  - Tapping a category opens the drill-down with `categoryId` (or `uncategorized`) and `from`/`to` of the window.
  - The empty state reads "Statistics appear after your first full month." when `months` has no complete month.
  - Error and offline states use the Home patterns.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** with pull-to-refresh and React Query.
- [ ] **Step 4: Update** `docs/specs/mobile.md` (a Statistics section). Run the mobile tests and `SKIP_INTEGRATION=1 bash ci/check.sh` → PASS.
- [ ] **Step 5: Commit** `feat(mobile): statistics tab`.

# MoneyWave Usable Finance Cockpit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the report-like MoneyWave UI with the approved compact finance cockpit while preserving the encrypted ledger and all existing reconciliation results.

**Architecture:** SQLCipher and `MoneyWaveReadRepository` remain the only financial source of truth. Typed read-model additions provide prior-period comparisons, URL-safe period/currency selection, transaction evidence summaries, and period-aware movement chains; Server Components render those models while small Client Components own filters, row expansion, and drawers. No import, matching, categorization, or cost mutation path changes.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript 5.9, SQLCipher, CSS, accessible local SVG, Vitest, Playwright.

**Execution constraints:** Work inline on the existing unborn `main`; native subagents, worktrees, staging, commits, pushes, remotes, external assets, telemetry, and financial-data mutation are not authorized. Tests and UI examples use synthetic values only.

---

### Task 1: Extend report and detail read models

**Files:**
- Modify: `src/domain/reporting.ts`
- Modify: `src/server/read-model/repository.ts`
- Modify: `tests/domain/reporting.test.ts`
- Modify: `tests/server/read-repository.test.ts`

- [x] **Step 1: Add failing period-range tests**

  Cover safe currency parsing and previous-period bounds for `30d`, `90d`, `12m`, and `all`. Expected examples use synthetic 2099 timestamps and require `all` to return no comparison range.

- [x] **Step 2: Run the focused domain test and confirm red**

  Run `PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm vitest run tests/domain/reporting.test.ts`.

- [x] **Step 3: Implement safe report query helpers**

  Add `parseReportCurrency(value, available)` and `previousReportPeriodRange(anchor, period)` without accepting arbitrary SQL or display values.

- [x] **Step 4: Add failing repository assertions**

  Extend the synthetic dashboard test to require:

  - `OverviewView.previousFlows` separated by currency;
  - `CategoryAnalyticsView.previousTotals` separated by currency;
  - transaction rows with movement status/evidence/cost summary;
  - `transactionPage({ period, ... })` using the ledger anchor;
  - period-aware movement-chain detail with ordered legs and costs.

- [x] **Step 5: Run the focused repository test and confirm red**

  Run `PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm vitest run tests/server/read-repository.test.ts`.

- [x] **Step 6: Implement minimal parameterized queries**

  Reuse shared date predicates and latest-category joins. Extend existing interfaces instead of adding a second repository. A transaction summary exposes only its existing private description plus safe local evidence counts, group status, matching method, category method, and cost count. Movement chains use confirmed/reconciled groups only and retain ordered legs.

- [x] **Step 7: Rerun both focused tests**

  Expected: all reporting and repository tests pass with no database writes outside the isolated synthetic test database.

### Task 2: Replace the application shell and shared report controls

**Files:**
- Modify: `src/app/layout.tsx`
- Modify: `src/components/navigation.tsx`
- Modify: `src/components/page-heading.tsx`
- Replace: `src/components/period-switcher.tsx`
- Create: `src/components/report-controls.tsx`
- Modify: `src/app/globals.css`
- Modify: `tests/e2e/moneywave.spec.ts`

- [x] **Step 1: Add failing shell acceptance assertions**

  At 1280 px and 905 px, assert that the shell uses a banner/top navigation, has no `.sidebar`, exposes Ukrainian navigation labels in the approved order, and does not overflow horizontally. At 390 px, assert the navigation remains reachable without expanding page width.

- [x] **Step 2: Run the desktop/mobile browser test and confirm red**

  Run `PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm test:e2e --grep "usable shell"`.

- [x] **Step 3: Implement the compact shell**

  Render brand, navigation, and privacy status in one top bar. Keep navigation keyboard accessible and use `aria-current`. Replace marketing-style page eyebrows with concise title, scope, and action slots.

- [x] **Step 4: Implement `ReportControls`**

  Generate Link-based period/currency controls that preserve only allowlisted query state. Hide currency choices with no data. Keep the current `PeriodSwitcher` API as a compatibility wrapper until all pages migrate.

- [x] **Step 5: Establish the approved visual tokens**

  Use one system sans family, tabular numerals, graphite top bar, warm neutral surface, green income, coral outflow, and amber evidence warnings. Preserve setup/import form classes, visible focus, and reduced-motion behavior.

- [x] **Step 6: Rerun the shell acceptance test, lint, and typecheck**

  Expected: browser assertions pass and no existing setup/import behavior regresses.

### Task 3: Rebuild Overview as the first-viewport cockpit

**Files:**
- Modify: `src/app/page.tsx`
- Modify: `src/components/cashflow-chart.tsx`
- Modify: `src/components/category-breakdown.tsx`
- Create: `src/components/metric-strip.tsx`
- Modify: `src/app/globals.css`
- Modify: `tests/e2e/moneywave.spec.ts`

- [x] **Step 1: Add failing Overview acceptance assertions**

  With synthetic imported data, require the selected currency, selected period, four decision metrics, cash-flow chart, account context, category links, and recent transaction links inside the 1280 px first viewport. Assert that reconciliation counts and implementation terminology are absent from Overview.

- [x] **Step 2: Run the focused browser test and confirm red**

- [x] **Step 3: Implement currency-aware summary selection**

  Parse the URL currency against available currency lanes. Show one currency at a time; never combine currencies. Derive percentage change from `previousFlows`, displaying `—` when no reproducible comparison exists.

- [x] **Step 4: Replace the line chart with an accessible grouped bar chart**

  Render income/outflow bars per bucket, useful axis labels, a local tooltip/summary, and links from buckets to the transaction period. Keep zero and single-bucket states legible.

- [x] **Step 5: Turn account, category, and recent rows into drill-down navigation**

  Preserve safe enum/account IDs in links. Monetary descriptions remain local and are never placed in URL query strings.

- [x] **Step 6: Rerun the focused browser test at 1280, 905, and 390 px**

  Expected: no overflow, no clipped key metric, and the primary information is visible without scrolling at 1280 px.

### Task 4: Make Transactions a usable ledger

**Files:**
- Modify: `src/app/transactions/page.tsx`
- Modify: `src/components/transactions-ledger.tsx`
- Create: `src/components/transaction-drawer.tsx`
- Modify: `src/app/api/transactions/search/route.ts`
- Modify: `src/app/globals.css`
- Modify: `tests/e2e/moneywave.spec.ts`

- [x] **Step 1: Add failing filter and table tests**

  Require safe initial filters from `period`, `currency`, `category`, and `account` URL keys; keep private search text exclusively in POST bodies. At 905 px require visible date, description, account, category, and amount with zero table/page horizontal scroll.

- [x] **Step 2: Add failing drawer assertions**

  Selecting a row must open a focusable drawer with amount, account, timestamp, type, category provenance, evidence count, movement status/method, and cost count. Escape and close button return focus to the triggering row.

- [x] **Step 3: Run the focused browser test and confirm red**

- [x] **Step 4: Implement the compact sticky filter toolbar**

  Keep search, account, currency, and category visible. Move type and direction under an accessible `details` disclosure. Apply/reset remains explicit; pagination retains current filters.

- [x] **Step 5: Implement the five-column responsive ledger**

  Columns are date, description, account, category, amount. Encode direction through sign/color and move implementation metadata into the drawer. At 390 px, collapse account/category into the description cell while preserving them in accessible detail.

- [x] **Step 6: Implement the local transaction drawer**

  Use the already-loaded typed summary; do not add external calls or expose financial data in the URL. Prevent background scroll while open and preserve keyboard navigation.

- [x] **Step 7: Rerun browser, API, lint, and typecheck checks**

  Expected: private search still uses same-origin CSRF-protected POST and all essential columns fit at 905 px.

### Task 5: Replace the fake flow map with expandable movement chains

**Files:**
- Modify: `src/app/money-flow/page.tsx`
- Replace: `src/components/money-flow-map.tsx`
- Create: `src/components/movement-chain-list.tsx`
- Modify: `src/app/globals.css`
- Modify: `tests/server/read-repository.test.ts`
- Modify: `tests/e2e/moneywave.spec.ts`

- [x] **Step 1: Add failing chain-ledger browser assertions**

  Require an ordered origin-to-destination row for a synthetic confirmed movement, an expandable leg list, matching evidence, cost provenance, and a collapsed evidence-boundary section. Assert the old three independent flow columns are absent.

- [x] **Step 2: Run focused repository and browser tests and confirm red**

- [x] **Step 3: Implement the movement chain list**

  Each summary shows date, source, destination, currencies/amounts, cost, and evidence status. Expansion shows ordered legs without inventing missing sides. Provider-described one-sided FX starts from the explicit source pool label.

- [x] **Step 4: Implement a truthful aggregate route summary**

  Use compact connected source→destination route rows sized by confirmed totals; do not imply category-level lineage that pooled funds cannot prove.

- [x] **Step 5: Move cost and coverage information into compact contextual summaries**

  Use Ukrainian labels and keep facts separate from estimates. Rejected candidates remain in Data, not the primary flow page.

- [x] **Step 6: Rerun focused tests and viewport checks**

### Task 6: Turn Categories and Data into drill-down surfaces

**Files:**
- Modify: `src/app/categories/page.tsx`
- Replace: `src/components/category-breakdown.tsx`
- Modify: `src/app/data/page.tsx`
- Modify: `src/app/globals.css`
- Modify: `tests/e2e/moneywave.spec.ts`

- [x] **Step 1: Add failing category comparison assertions**

  Require a ranked selected-currency table with amount, share, previous-period change, transaction count, and compact local trend. Clicking a category must open Transactions with allowlisted period/currency/category filters.

- [x] **Step 2: Add failing Data copy/layout assertions**

  Require concise Ukrainian account/import/audit labels, keep raw artifacts hidden, and place technical evidence boundaries below operational status.

- [x] **Step 3: Run focused browser tests and confirm red**

- [x] **Step 4: Implement category comparison and drill-down**

  Calculate percentages with bigint-safe arithmetic. Show `—` for missing comparison and separate currency lanes through the global control.

- [x] **Step 5: Simplify Data without losing audit evidence**

  Replace mixed English/internal terminology. Keep counts and parser metadata but remove oversized metric treatment.

- [x] **Step 6: Rerun browser, lint, and typecheck checks**

### Task 7: Full rendered verification and regression repair

**Files:**
- Modify only task-owned UI/tests/docs if verification exposes defects.
- Update ignored worklog: `tasks/worklogs/fop-money-flow.md`

- [x] **Step 1: Run the complete automated suite under Node 24**

  Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm verify:security`, `pnpm build`, and `pnpm test:e2e` with the Node 24 PATH prefix.

- [x] **Step 2: Run safe local-data validation**

  Run `pnpm verify:real-data`; require only safe `sample_N PASS/FAIL` output. Do not rerun the mutation operator.

- [x] **Step 3: Inspect live populated pages**

  Verify Overview, Transactions, Money Flow, Categories, and Data at 1280×900, 905×844, and 390×844. Exercise period/currency controls, category drill-down, transaction filters/pagination, row drawer, and chain expansion. Check console errors after navigation and interactions.

- [x] **Step 4: Perform the post-implementation review loop**

  Rate usability against the approved spec, inspect all task-owned diffs, fix safe findings, and rerun affected checks.

- [x] **Step 5: Verify repository and privacy boundaries**

  Confirm unborn `main`, no remotes, nothing staged, ignored financial/runtime paths, no candidate secrets, no real financial values in tracked docs/tests, and no external requests from the rendered app.

- [x] **Step 6: Update the ignored worklog and leave the loopback runtime ready**

  Record only the non-sensitive outcome, verification, residual usability risks, and next step.

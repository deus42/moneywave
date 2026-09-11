# MoneyWave Usable Finance Cockpit — Design

## Outcome

Replace the report-like interface with an operational finance workspace that answers common questions in one glance and lets every summary drill into the underlying transactions or movement chains.

## Approved direction

The user selected **A: Cockpit + ledgers**.

- Desktop and intermediate-width layouts use a compact top navigation instead of a persistent wide sidebar.
- The first viewport prioritizes current balances, income, terminal spending, movement costs, period comparison, and a legible cash-flow chart.
- Account, category, transaction, and movement summaries are navigation surfaces, not decorative cards.
- Dense tables fit their viewport without hiding essential columns behind page-level horizontal scrolling.
- Ukrainian product language replaces implementation terms such as `canonical ledger`, `terminal expenses`, `movement groups`, and `evidence legs` on primary surfaces.

## Information architecture

Primary navigation remains: Overview, Transactions, Money Flow, Categories, Data.

### Overview

- Global period and currency controls sit beside the page title and affect the whole page.
- The first row shows available evidenced balance, income, terminal spending, and fees/FX for the selected currency and period.
- A local SVG cash-flow chart compares income and spending over time and exposes transaction drill-down by time bucket.
- Account balances, top categories, and recent transactions are visible in the same viewport at common laptop widths.
- Technical reconciliation metrics move to Data.

### Transactions

- A compact sticky toolbar contains search and the most-used filters; additional filters live behind one disclosure.
- The primary table always preserves date, description, account, category, and amount at laptop width.
- Direction is encoded by amount sign and color rather than a separate space-consuming column.
- Selecting a row opens a local detail drawer with source evidence, movement membership, fees, FX, and categorization provenance.
- Pagination and filters remain server-backed; financial search text never enters the URL.

### Money Flow

- Summary tiles are limited to totals that help assess coverage or cost.
- The main surface is an expandable chain ledger: origin, intermediate legs, destination, cost, evidence status, and date.
- An aggregate route visualization is supplementary and must draw actual connected edges; independent columns are forbidden.
- Evidence boundaries are collapsed by default and clearly excluded from matched totals.

### Categories

- The default view compares selected and previous periods by category and currency.
- A ranked category table includes amount, share, change, transaction count, and a compact trend.
- Selecting a category opens its transactions with the current period and currency preserved.
- Coverage is a small status indicator, not the page's primary statistic.

### Data

- Data is the operational audit surface for accounts, imports, parser versions, encrypted backups, and evidence limitations.
- It does not resemble a manual review queue and does not expose raw artifacts by default.

## Visual system

**Visual thesis:** a compact, familiar finance workspace with a dark graphite navigation bar, warm neutral working surface, clear sans-serif numbers, and one restrained green accent.

**Content plan:** orientation and global controls, decision metrics, one primary analytical surface, then linked supporting ledgers.

**Interaction thesis:** fast filter transitions, row-to-drawer reveal, and chart/category hover states that lead directly to detail. All motion respects reduced-motion preferences.

- Use one sans-serif family and tabular numerals for monetary values.
- Use green for income/positive state, coral for outflow, and amber only for evidence limitations.
- Reduce headings, padding, rounded containers, and marketing-style eyebrow copy.
- Avoid card mosaics, oversized empty areas, ornamental labels, and mixed English/Ukrainian UI copy.
- Keep all assets and chart rendering local; no external fonts, analytics, or requests.

## Component boundaries

- `AppShell`: top navigation, responsive overflow behavior, privacy status.
- `ReportControls`: period and currency selection shared by analytical pages.
- `MetricStrip`: compact, currency-aware totals with prior-period comparison.
- `CashflowChart`: accessible local SVG with bucket drill-down.
- `TransactionTable` and `TransactionDrawer`: responsive ledger and evidence detail.
- `MovementChainList` and `MovementChainDrawer`: expandable matched paths and cost evidence.
- `CategoryTable`: ranked comparison and transaction drill-down.
- Existing server read repositories remain the source of truth; new comparison or detail queries extend them rather than duplicating financial logic in React components.

## Data flow and safety

1. URL-safe period/currency keys select server-side read-model queries.
2. Server Components render aggregate and paginated results from SQLCipher.
3. Private text search remains a CSRF-protected same-origin POST.
4. Client Components hold only interaction state such as open drawer, filter disclosure, or selected chart bucket.
5. No UI redesign changes imported evidence, movement matches, categories, costs, or raw artifacts.

Missing evidence remains explicit and excluded from reconciled totals. The UI must never imply an inferred balance, movement link, date, cost, or exchange rate.

## Error and empty states

- Each analytical surface distinguishes no activity, unavailable balance evidence, and query failure.
- Failed filters or detail loads preserve the current page and show a concise local error.
- Long descriptions truncate in rows and remain readable in the detail drawer.
- Empty currencies and periods disappear from selectors rather than producing empty dashboard shells.

## Verification targets

- At 1280 px and 905 px, the first Overview viewport contains controls, metrics, chart, and account context without a wide sidebar.
- At 905 px, transaction date, description, account, category, and amount are visible without page or table horizontal scrolling.
- At 390 px, primary pages have no horizontal overflow; secondary fields collapse into row detail.
- Overview metrics and charts respect the same period and currency selection.
- Category and chart drill-downs land on correctly filtered transactions.
- Movement chains show their actual legs and never imply links absent from the database.
- Keyboard navigation, visible focus, reduced motion, accessible names, and contrast pass browser acceptance.
- Lint, typecheck, unit/integration tests, Playwright desktop/intermediate/mobile scenarios, security checks, safe real-data validation, and production build pass.

## Stop conditions

- Do not mutate financial data as part of the redesign.
- Do not add remote assets, telemetry, public APIs, or new external data flows.
- Do not stage, commit, push, or configure a remote.
- Stop rather than hiding a key financial field behind horizontal scroll at the target laptop width.

# MoneyWave Net Worth, Insights, and Manual Workbook Migration — Design

Status: product design reopened by the requester. Read `2026-09-04-moneywave-product-review.md` before creating an implementation plan. Technical review of this document did not constitute acceptance of the daily user experience.

## Outcome

Turn MoneyWave into a familiar personal-finance workspace with three new first-class capabilities:

1. a Net Worth center that explains every evidenced position;
2. an Insights center that explains spending, taxes, currency exposure, and the cost of moving money;
3. a safe one-time migration of the user-provided manual finance workbook into typed local domains without duplicating the bank ledger.

This design supersedes the navigation and visual-shell portions of `2026-09-03-usable-finance-cockpit-design.md`. Existing import, ledger, movement, cost, categorization, and valuation rules remain authoritative.

## Approved Product Direction

The requester approved direction A: a calm, familiar personal-finance application rather than a technical control room.

- Desktop uses a dark left navigation rail and a quiet off-white workspace.
- Mobile uses a compact top bar and bottom navigation.
- Typography is comfortably readable; dense finance detail is organized with spacing and dividers rather than a grid of small cards.
- The report-currency selector recalculates the complete eligible view in UAH, EUR, or USD. It never filters transactions by native currency.
- Native values, reporting values, evidence source, and freshness remain visible where they affect interpretation.
- Motion is limited to fast page, row, drawer, and chart transitions and is removed under reduced-motion preferences.

Primary navigation becomes:

- Overview
- Net Worth
- Transactions
- Money Flow
- Insights
- Data

Categories and Cost of Money become focused Insights views. Their existing URLs may redirect while preserving period and report-currency parameters.

## Scope and Non-Goals

### Included

- Redesign the shared application shell and Overview in the approved visual direction.
- Add `/net-worth` and `/insights` as server-rendered analytical routes.
- Add account-position, Net Worth history, allocation, hidden-cost, category-change, recurring-cost, tax, and currency-exposure read models.
- Import the observed six-sheet manual workbook as encrypted immutable evidence.
- Materialize only typed, defensible manual facts and reconciliation links.
- Expose workbook migration coverage and unresolved evidence under Data.
- Make the affected routes usable at desktop, intermediate laptop, and mobile widths.

### Excluded

- Live Google Drive/Sheets integration, OAuth, background synchronization, or editing the source workbook.
- Replacing the canonical bank ledger with spreadsheet totals.
- Creating transactions from summary cells, formulas, targets, or allocation balances.
- Inventing account ownership, transaction dates, currencies, debt balances, or matches.
- Crypto, IBKR, security lots, market prices, or investment performance.
- New bank integrations, public deployment, telemetry, or broader AI access.

## Workbook Evidence and Domain Mapping

The source is a user-authorized, read-only workbook snapshot with six distinct sheets. The application treats workbook content as untrusted data, never as instructions.

### `Savings`

Observed shape: a historical matrix with period labels, several position columns, cash, totals, changes, and target calculations.

- Accept only the observed position matrix: the explicit month/year label plus direct, non-formula cells under the allowlisted position headers. Totals, projections, increments, targets, blank future rows, and any value outside that matrix are not positions.
- Normalize a month label to its calendar month-end. An invalid, duplicate, or unsupported period is unresolved.
- Convert the direct position cells into monthly manual position observations.
- Resolve each position label to an existing MoneyWave account only when local evidence supports the identity.
- A position linked to an existing account becomes additional balance evidence, not another asset.
- An unlinked but clearly distinct asset may become a manual position with `manual_document` provenance.
- Totals, increments, and target formulas remain source evidence and are not imported as positions.

### `Budget`

Observed shape: recurring-item tables, monthly/yearly currency calculations, dated history blocks, and salary/savings planning formulas.

- Treat each direct item in the two allowlisted item/price/status tables as a `budget_line`. Formula-derived monthly/yearly or converted siblings are alternate representations and are not separate lines.
- A line becomes an active recurring obligation only when its source status is active and the item is in the allowlisted recurring-service or essential-obligation mapping. Otherwise it remains a budget plan.
- Treat each direct amount/date pair in an allowlisted dated category block as a `manual_expense_observations` fact. It may link to one unique ledger entry, otherwise remains visible manual reconciliation evidence; it never becomes a bank transaction or contributes to actual spending.
- Preserve source currency and period/cadence.
- Map labels to the canonical MoneyWave taxonomy through explicit aliases.
- Keep salary/tax/FX/savings scenario calculators and derived monthly/yearly formulas as formula-only evidence.
- A budget line never becomes an actual expense.

### `Big Buys`

Observed shape: item, price, date, and month rows plus derived summaries.

- A dated row with one defensible ledger counterpart becomes a linked large-purchase annotation.
- A future-dated direct row becomes a planned purchase/sinking-fund item.
- A past unmatched row or non-unique match remains unresolved and excluded from spending totals; historical data is never silently reinterpreted as a future plan.
- Summary and per-month formulas remain formula-only evidence.

### `Spendings`

Observed shape: repeated period blocks containing category labels, UAH/EUR values, conversion rates, and formula totals.

- Define one economic observation by workbook lineage, period block, canonical category, and native currency. Batch and coordinates are evidence occurrences, not fact identity.
- Import each direct UAH or EUR input as its own native-currency component. When both are direct, they are two components of the same category/period summary rather than alternate totals.
- Treat the rate and total columns as reference/derived fields only. They are never independently aggregated.
- Reconcile summaries against canonical ledger category aggregates at the same period and currency scope.
- Store the reconciliation result and residual; never synthesize individual transactions.
- Formula totals and converted totals remain formula-only evidence. MoneyWave independently converts the native components through its official valuation engine.

### `Utilities`

Observed shape: month/year rows with utility components, EUR totals, UAH totals, and manual rates.

- Define one economic observation by workbook lineage, month, component, and native currency. Batch and coordinates are evidence occurrences, not fact identity.
- Import direct component inputs as recurring-bill history at month granularity.
- Map components to canonical recurring/housing categories.
- Treat the supplied rate as manual execution/reference evidence only.
- Compare the history to monthly ledger aggregates; do not force a transaction link without a transaction date and unique counterpart.
- Derived EUR/UAH totals remain formula-only evidence and are never independently aggregated.

### `Dreams`

Observed shape: goal rows with price/target calculations and a separate balance/allocation block.

- Accept only direct, non-formula inputs from the allowlisted goal rows. Derived delta, converted price, converted target, net target, and total cells remain formula-only evidence.
- Import each direct goal label and target input as a financial goal. Direct progress inputs become `goal_progress_observations`; they are not positions.
- Import the separate balance block only as `goal_allocations` linked to an existing account/manual position when that backing identity is proven. An ambiguous backing identity is unresolved.
- Goal allocations describe purpose, not additional assets; a database-level constraint prevents them from entering Net Worth.
- Derived targets and totals are reproduced by domain calculations only when their inputs are valid.

## Persistence Design

Reuse `import_artifacts` for the encrypted raw workbook bytes and SHA-256 identity. Add a separate manual-workbook normalization boundary instead of weakening the bank-specific `source_records.row_state` contract.

### Migration tables

- `manual_source_lineages`
  - identifies one user-authorized workbook lineage locally without storing its external URL or document identifier;
  - future snapshots attach to the lineage through an explicit local source selection and matching sheet contract.
- `manual_workbook_batches`
  - references one lineage and one `import_artifacts` row;
  - records parser version, lifecycle status, source-record count, outcome counts, and commit timestamp.
- `manual_workbook_records`
  - represents one source occurrence and identifies batch, sheet, and source row/cell block without exposing it in logs;
  - stores a stable fingerprint, typed record kind, validation status, disposition, and safe reason code;
  - validation status is exactly `accepted` or `rejected`;
  - every accepted record has exactly one disposition: `linked_to_ledger`, `manual_fact`, `formula_only`, `structural`, or `unresolved`; a rejected record has no disposition and requires a reason code.
- `manual_facts`
  - provides a lineage-stable logical identity for a normalized fact, independent of batch and cell coordinates;
  - stores fact kind, logical key, and immutable value fingerprint; the logical key uses the lineage, domain, period/date, currency, and recovery-key-derived HMAC of the normalized local label where applicable.
- `manual_fact_evidence`
  - is a many-to-many relation between source occurrences and logical facts;
  - a repeated fact in a later workbook snapshot attaches new provenance to the existing fact instead of duplicating it.
- `manual_positions`
  - references one `manual_facts` row and stores asset/liability side, native minor units, currency, observation date, label, optional linked account, and inclusion status;
  - logical identity is either `account:<account_id>` for linked evidence or an immutable `manual:<position_key>` for a distinct position.
- `manual_position_valuations`
  - stores reproducible UAH/EUR/USD values, requested/publication dates, rate, source, and formula version for unlinked manual positions.
- `budget_lines`
  - stores plan period/cadence, category/alias, native amount, currency, and active status.
- `recurring_obligation_observations`
  - stores month-granularity actual/manual history separately from planned budget values.
- `manual_expense_observations`
  - stores direct dated amount/category evidence from workbook history blocks, with optional unique ledger-entry link and reconciliation status;
  - remains an evidence layer and is excluded from canonical income/spending queries.
- `planned_purchases`
  - stores label, target amount/currency/date, optional linked ledger entry, and state.
- `financial_goals`
  - stores label, target amount/currency, target date when present, and status.
- `goal_progress_observations`
  - stores direct progress values and observation dates without claiming that progress is a separate asset.
- `goal_allocations`
  - links a goal to a backing account or distinct manual position and stores the allocated amount/currency;
  - requires exactly one backing identity and is excluded from all Net Worth queries by schema and repository contract.
- `manual_category_summaries`
  - stores one native component per economic-observation identity, plus non-aggregating reference-rate/alternate-display evidence and its reconciliation status/residual against the bank ledger.
- `net_worth_coverage_attestations`
  - stores an explicit dated `no_liabilities` assertion only when the user supplies one;
  - absence means liability coverage is unknown, never zero.

Every domain row references one `manual_facts` row. Every accepted non-structural source occurrence either links to one or more facts or has the formula-only/unresolved disposition, and every fact retains one or more evidence references. Private labels remain inside SQLCipher. No raw cell payload is copied into audit logs.

### Duplicate and inclusion rules

- Artifact SHA-256 rejects an exact repeat.
- Record fingerprints identify repeated source occurrences; lineage-stable logical keys and immutable value fingerprints make overlapping snapshots idempotent.
- The same logical key and value fingerprint merges provenance. The same logical key with a different immutable value becomes an explicit source conflict and leaves the new occurrence unresolved; it never overwrites the existing fact.
- A manual position linked to an account is evidence for that account, not a second position.
- A manual category summary never contributes to income or spending totals.
- A planned purchase or budget line never contributes to actual spending.
- Goal progress and allocations never contribute to assets; only their proved backing position can contribute.
- Only `manual_positions.inclusion_status = 'distinct_evidenced_position'` contributes to Net Worth.
- Missing or ambiguous identity produces `unresolved`, not an inferred asset or liability.

### Logical-position coalescing

- All bank/API/statement/manual observations for a linked account share `account:<account_id>` and produce at most one logical position at any boundary.
- A distinct manual position uses a stable normalized source-position key scoped to the workbook lineage, not its display label alone.
- For an as-of boundary, choose the latest observation date at or before the boundary. Never carry evidence backward before its first date.
- Identical values with the same logical identity, date, and currency merge as multiple evidence references.
- Conflicting same-date values create a reconciliation conflict. Provider API/statement evidence may remain the selected account fact over manual-document evidence, but the conflict is visible and the manual value never becomes a second position.
- Conflicting equal-authority values suppress that logical position from complete totals until later unambiguous evidence resolves the boundary.
- Later observations supersede earlier observations for presentation only; source evidence remains immutable.

## Import and Migration Flow

1. Before starting the browser export, create a random process-owned acquisition directory with mode `0700`, choose the exact final XLSX path inside it, and write an ignored process-owned `0600` recovery manifest outside that directory. The initial manifest records an `acquiring` state, the exact directory and final-file paths, the directory's device/inode identity, and every implementation-known temporary sibling filename the browser may use. Configure the user's authenticated read-only browser export to write directly to that destination. If the browser boundary cannot guarantee this destination without creating another download copy, stop before export. The MoneyWave application receives no Google credentials or ongoing network access.
2. When export completes, `lstat` the acquisition directory and final file, reject changed directory identity, symlinks, non-regular files, unexpected directory entries, or ownership by another user, change the final file to `0600`, calculate SHA-256, and atomically advance the manifest to `acquired` with the file's device/inode identity and hash. Treat this dedicated directory as the sole plaintext location and ingest the final file directly into SQLCipher; do not copy it into `data/` or another staging location.
3. On normal success or failure, unlink the manifest-listed files, remove the now-empty acquisition directory, and remove the manifest. On the next MoneyWave operator startup, process stale manifests before any other application work. For an `acquiring` manifest, revalidate directory path, ownership, device/inode identity, and an allowlist-only directory listing before unlinking only its predeclared regular-file members. For an `acquired` manifest, additionally revalidate the final file's device/inode identity and hash. A mismatch or unexpected entry is a safe stop, never a broader filesystem scan or deletion.
4. Create and verify a non-empty encrypted backup before schema migration or workbook commit.
5. Store the original workbook bytes as an encrypted immutable artifact.
6. Apply the container and parser limits below, parse formulas without executing them, and reject external links, macros, unsupported sheets, oversized dimensions, and malformed dates with safe codes.
7. Produce a local preview containing structural counts and proposed domain mappings, never raw values in logs. Persist its artifact hash, parser version, and mapping digest.
8. Reconcile candidate positions, purchases, categories, and recurring observations against the existing ledger and balance evidence.
9. Commit only when the submitted artifact hash, parser version, and mapping digest exactly match the unexpired preview. Recompute the digest server-side, then commit the batch atomically.
10. Materialize UAH/EUR/USD valuations for eligible manual positions using the existing official-rate service.
11. Run deterministic read-model checks, SQLCipher integrity, foreign keys, and a temporary restore verification.
12. Create and verify a post-import encrypted backup.
13. Verify that the plaintext acquisition directory and cleanup manifest are absent before reporting completion; the encrypted database artifact and verified encrypted backups are the retained copies. Unlinking limits retention but is not represented as guaranteed secure erasure, so plaintext lifetime remains as short as possible.

The one-time operator command prints only aggregate outcome counts and safe error codes. It never prints workbook labels, dates, amounts, formulas, or source coordinates.

### Untrusted XLSX limits

Reject before normalization when any bound is exceeded:

- 25 MiB compressed input;
- 256 ZIP entries, 100 MiB total declared uncompressed bytes, 50 MiB for one entry, or a compression ratio above 100:1;
- any macro, embedded object, external link, connection, or path-traversal ZIP entry;
- six expected worksheets only, 100,000 rows per sheet, 128 columns per sheet, or 250,000 populated cells for the workbook;
- 32,768 characters in one text cell, 4,096 characters in one formula, or 20 million shared-string characters;
- ten seconds of parser wall time or 256 MiB worker heap.

ZIP central-directory checks happen before decompression. Workbook parsing runs in a bounded worker; timeout, memory termination, malformed containers, and limit failures produce atomic safe error codes.

Official-rate materialization is cache-first. If an eligible manual position lacks a cached rate, the server may use the already approved ECB/NBU boundary with date and currency pair only. It never sends workbook metadata, labels, positions, amounts, identifiers, or derived totals. Browser acceptance still requires zero external browser requests; server egress is separately allowlisted and tested.

## Net Worth Center

### Summary

The page computes evidenced Net Worth in the selected report currency:

`evidenced assets - evidenced liabilities`

The read model returns one explicit coverage state:

- `complete`: every included logical position has a valuation, no unresolved identity/value conflict affects the boundary, and liability coverage is supported by imported liability evidence or an explicit dated no-liabilities attestation;
- `asset_only`: assets are valued but liability coverage is absent;
- `partial_valuation`: logical identities are settled, but at least one included position lacks a reporting valuation;
- `incomplete_evidence`: an unresolved identity, equal-authority value conflict, or other evidence conflict can change which positions belong in the boundary.

Coverage precedence is deterministic: `incomplete_evidence`, then `partial_valuation`, then `asset_only`, then `complete`. Only `complete` may label the primary number “Net Worth” and show Net Worth change/decomposition. `asset_only` labels it “Підтверджені активи · зобов’язання не підключені”; it may show asset allocation but suppresses Net Worth change/decomposition. `partial_valuation` and `incomplete_evidence` label the number “Відомий subtotal”, list the exact excluded coverage class, and suppress total allocation percentages, change, and decomposition. No state implies that missing liabilities, identities, or values are zero.

The page also shows position count, valuation coverage, freshness warnings, and the evidence date. A future explicit no-liabilities attestation is configuration evidence, not a default or inference.

### Position ledger

Group positions in this slice by Personal, Sole Proprietor, Cash, and Manual. Do not render an empty Investments group or add investment abstractions. Each row shows:

- display name and provider/domain;
- native amount and currency;
- converted report value;
- observation date/freshness;
- evidence kind;
- whether the position is included, linked, stale, or excluded.

Filters select Personal, Sole Proprietor, or All. They do not change ownership or persistence.

### History and allocation

- For each month boundary, apply the logical-position coalescing rules and select at most one observation per logical position.
- Never carry a position backward before its first evidence.
- Carrying a stale position forward remains visually marked and reports its age.
- Sum stored per-position valuations so the curve reconciles to position drill-down.
- Allocation views group by owner scope, account type, currency, and evidence class.
- Goals are shown as allocations/progress against existing assets, never as extra assets.

## Insights Center

Insights are deterministic read-model outputs. AI does not create, rank, or explain financial facts.

### Hidden cost view

Keep these methods separate in totals, trend lines, labels, and drill-down:

- `explicit_statement_fee`: provider/statement fact;
- `same_currency_transfer_gap`: confirmed conservation difference;
- `fx_spread_estimate`: official-benchmark estimate;
- `manual_cost`: user-confirmed cost;
- `unexplained_gap`: unresolved residual, never labelled as a fee.

Each row opens the supporting movement group or transaction evidence and shows the calculation provenance already stored by the cost engine.

### Insight feed

Generate a short prioritized feed from explicit rules:

- largest period-over-period category changes with minimum materiality and sample thresholds;
- changes in recurring obligations and manual-versus-ledger reconciliation;
- tax and mandatory-payment share of gross FOP income;
- currency concentration and valuation-coverage warnings;
- increases in explicit fees, transfer gaps, or FX estimates;
- newly observed unexplained gaps or stale positions;
- Net Worth change decomposition without counting owner draws twice.

Every item includes a method code, comparison window, data coverage, and destination drill-down. If the evidence threshold is not met, the insight is omitted rather than guessed.

### Versioned insight methods

`insights-v1` fixes calculation and ordering so results are reproducible:

- Comparison window is the selected period versus the immediately preceding equal-length period. A 24-month view therefore needs the preceding 24 months for a change claim; otherwise it reports current composition only.
- Category change requires at least three terminal transactions in both windows, at least 2% current spending share, and either a 25% amount change or three-percentage-point share change. A category absent in the previous window requires at least five current transactions and 5% share.
- Recurring change compares the latest three complete months with the previous three, requires at least two observations in each window, and surfaces a change of at least 10%. Manual-versus-ledger residuals reconcile in native minor units; converted comparisons allow only the recorded per-entry rounding already used by the valuation engine.
- Tax share numerator is `tax + mandatory_payment`; denominator is gross FOP business income. Business expense and owner draw are shown separately. The ratio is suppressed when gross income is zero or valuation coverage is incomplete.
- Currency concentration is surfaced at 60% of fully valued evidenced assets. Missing valuation produces a coverage warning instead of a concentration claim.
- A cost-method increase requires at least two components in the current window and a 25% increase over the previous window. A new `unexplained_gap` is always higher priority than a cost trend.
- Bank/API positions become stale after 31 days and month-granularity manual positions after 45 days. Staleness affects coverage messaging but never edits evidence.
- Priority order is: unexplained gap or active reconciliation conflict; missing valuation/partial position; material hidden-cost increase; complete Net Worth change; recurring/tax change; category change; currency concentration. Ties use absolute impact in the selected report currency, then method code and stable entity ID.

Every insight response includes `methodVersion`, threshold inputs, coverage counts, and a stable drill-down descriptor. Synthetic acceptance fixtures lock the thresholds, suppression rules, and tie-breakers.

### Subviews

- For You: prioritized deterministic feed.
- Hidden Costs: cost method totals, trends, and evidence drill-down.
- Categories: the existing category comparison, promoted into the new shell.
- Recurring: budget, obligation, and utility history versus ledger actuals.
- Taxes: gross income, taxes, mandatory payments, business expenses, and owner draw semantics.
- Currencies: position exposure and native/report valuation coverage.

## Shared UI Components

- `AppShell`: desktop rail, mobile bar, privacy status, and content frame.
- `Navigation`: six primary destinations with responsive labels and accessible current-page state.
- `ReportControls`: shared period and report-currency selection.
- `NetWorthSummary`, `NetWorthChart`, `PositionLedger`, `AllocationBreakdown`.
- `InsightFeed`, `HiddenCostBreakdown`, `CurrencyExposure`, `RecurringSummary`.
- `WorkbookMigrationSummary`: source/domain mapping, outcome counts, and safe reason-code coverage.
- Existing transaction and movement drawers remain the drill-down destinations for bank-backed facts.
- `ManualEvidenceDrawer` shows only the bounded normalized fields needed to explain a workbook-only position, goal, budget line, recurring observation, planned purchase, or reconciliation residual: domain kind, local label, period/date, native value, report valuation when applicable, source sheet, formula/direct provenance, linked logical position/ledger aggregate, disposition, and safe reason code. It does not expose unrelated cells or raw artifact bytes.

Server Components fetch read models. Client Components own only local interaction state such as tabs, drawer visibility, chart hover, and compact mobile disclosure.

## Data Center

The existing Data contract remains authoritative for bank accounts, import history, analysis health, evidence limitations, and privacy. Extend it with three focused sections:

- Sources: account/provider coverage plus manual workbook source, parser version, encrypted-artifact state, and latest evidence dates.
- Workbook batches: preview/committed/failed lifecycle, validation counts, exhaustive disposition counts, mapping digest, and backup/restore verification status.
- Migration coverage: counts by sheet/domain and safe reason code, linked/manual/formula/structural/unresolved disposition, valuation coverage, and reconciliation residual status.

Selecting a workbook batch opens a local detail view. Accepted facts may open `ManualEvidenceDrawer`; unresolved/rejected records show sheet, domain kind, safe reason, and bounded normalized fields without becoming a manual-review queue. The UI never exposes raw workbook bytes, unrelated cells, account identifiers, or logs. Failed and rolled-back batches remain visible as safe operational history.

## Error, Empty, and Honesty States

- No balance evidence: show the account but exclude it from Net Worth.
- Missing valuation: preserve the native value, exclude the converted value, and show exact coverage.
- Stale position: include only according to its explicit inclusion rule and label the observation date.
- No liabilities connected: state incomplete liability coverage instead of displaying a confident zero.
- No cost in a method: show a neutral empty row only where comparison value is useful.
- Workbook parser mismatch: reject atomically with a safe sheet/schema code.
- Workbook record ambiguity: persist accepted validation plus `unresolved` disposition, exclude it from totals, and expose its bounded local evidence only through Data detail.
- Reconciliation residual: preserve both sources and show the residual; never overwrite the bank ledger or claim agreement.
- Route/read failure: preserve the shell and controls, show a concise local error, and emit no private payload.

## Security Boundary

- The source Google workbook is read only; no write-back or ongoing connector is added.
- Retained workbook bytes, labels, goals, budgets, manual positions, and derived reconciliation remain local and encrypted. Before browser export, the operator creates one `0700` acquisition directory and a narrowly scoped ignored `0600` recovery manifest; the browser writes directly there, the completed XLSX becomes `0600`, and manifest-listed plaintext is unlinked after success, failure, or validated stale-manifest recovery on the next operator startup.
- The external Google URL, workbook identifier, source values, and cell coordinates do not enter tracked docs, Vault-Tec, logs, test fixtures, or worklogs.
- Test fixtures are independently synthetic and structurally representative only.
- No workbook content is sent to OpenAI. The existing narrowly sanitized merchant-label categorization exception is unchanged.
- Host/Origin, CSRF, loopback binding, no-CORS, CSP, and no-telemetry controls remain enforced.

## Verification Targets

### Workbook and persistence

- Synthetic six-sheet fixture proves every supported sheet mapping and every outcome state.
- Mapping tests lock the observed allowlisted cell regions, direct-versus-formula rules, past-versus-future purchase treatment, and economic-observation identity for multi-currency inputs.
- Formula cells are detected but never executed or materialized as ledger facts.
- ZIP bombs, macros, external links, embedded objects, path traversal, oversized entries/cells/strings/formulas, parser timeout, and worker memory exhaustion fail with safe codes before commit.
- Exact artifact repeat and overlapping record import are idempotent.
- Commit rejects an expired or mismatched artifact hash, parser version, or mapping digest.
- A forced failure rolls back all normalized workbook facts.
- The plaintext acquisition directory and its `0600` cleanup manifest are absent after success and forced failure. Killed-process fixtures at pre-export, in-progress export, post-export/pre-hash, and acquired states prove validated stale-manifest cleanup on the next startup; directory/file identity mismatch, an unexpected entry, or a hash mismatch proves a safe stop without deleting anything.
- Position/account identity conflicts and non-unique purchase matches remain unresolved.
- Manual summaries, goals, plans, and allocations do not change canonical income/spending.
- Net Worth inclusion tests prove linked accounts and allocation balances are never double-counted.
- Backup-before-migration, post-import backup, checksum, SQLCipher integrity, foreign keys, and temporary restore pass.

### Read models

- Net Worth total equals included asset positions minus evidenced liabilities in the selected report currency.
- Monthly history uses only evidence available at each boundary and exposes stale/missing coverage.
- Same-date duplicate evidence coalesces once; manual/provider conflicts follow authority rules; equal-authority conflicts suppress the position.
- `complete`, `asset_only`, `partial_valuation`, and `incomplete_evidence` states enforce their respective label and suppression rules. Combination fixtures prove the precedence `incomplete_evidence` over `partial_valuation` over `asset_only` over `complete` when identity conflict, missing valuation, and absent liability coverage coexist.
- UAH/EUR/USD controls recalculate rather than filter.
- Hidden-cost totals reconcile exactly to their method-specific components.
- Category, tax, recurring, and currency insights meet explicit materiality/coverage rules and link to their source view.
- Owner draw and internal transfers never appear as additional income or spending.

### Browser acceptance

- At 1280 px and 905 px, the primary number, controls, chart, and position/cost context are readable without page-level horizontal scrolling.
- At 390 px, all six primary routes avoid horizontal overflow and use the bottom navigation.
- Net Worth position rows retain native amount, reporting amount, freshness, and evidence through responsive disclosure.
- Insights cost types remain visually distinct and keyboard-accessible.
- Workbook mapping and outcome coverage are visible under Data without displaying raw source values.
- Category, chart, position, cost, and insight drill-downs preserve period and report currency.
- Visible focus, accessible names, semantic tables/lists, contrast, and reduced motion pass.

### Repository checks

- Focused unit/integration tests pass during each red-green cycle.
- `pnpm verify`, `pnpm verify:real-data`, and the production build pass.
- Live loopback desktop and mobile readback show no console errors, page errors, external requests, or sensitive URLs.
- Browser requests remain same-origin; any server-side ECB/NBU cache miss contains date/currency pair only and is restricted to the approved hosts.
- `git check-ignore` confirms the local workbook snapshot, derived import state, database, and backups cannot be tracked.
- Git remains on unborn `main` with no remote, nothing staged, and no commit.

## Stop Conditions

- Stop before schema migration or workbook commit if a verified non-empty backup and restore path cannot be proven.
- Stop rather than interpreting an ambiguous manual position as a new asset or liability.
- Stop rather than converting a spreadsheet total into a transaction.
- Stop rather than silently dropping or overwriting a workbook record.
- Stop rather than sending workbook content or derived financial values to any external service.
- Do not stage, commit, push, deploy, add a remote, or modify the Google workbook.

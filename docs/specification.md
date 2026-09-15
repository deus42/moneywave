# MoneyWave product specification

Status: current product contract and explicitly deferred scope. Baseline: 2026-09-15.

## 1. Purpose and authority

MoneyWave replaces a personal finance spreadsheet with an explainable, private record of where money is held, where it came from, where it went, and what moving it cost. It serves one owner, including their personal accounts and sole-proprietor business activity. The product is a full personal finance hub delivered in independently verifiable increments.

The owner must be able to answer:

- What assets and liabilities are known at a selected date, in which accounts and currencies, and with what evidence?
- How much was earned, spent, paid in tax, lost to explicit costs or estimated FX spread, and retained during a period?
- Which bank records describe the same economic movement, and which differences remain unexplained?
- How do actual expenses compare with category budgets, previous periods, trips and large purchases?
- Can a correction be explained, retained through reprocessing, and reversed without changing the original evidence?

### Document responsibilities

| Document | Responsibility |
| --- | --- |
| [Requirements](requirements.md) | The owner's high-level needs and accepted product intent. |
| This specification | Detailed behavior, invariants, scope, interfaces and acceptance criteria. Requirement IDs are stable references for changes. |
| [Architecture](architecture.md) | Implementation boundaries and the selected technical shape. |
| [Decisions](decisions.md) | Dated decisions and their explicit supersession. Rejected and superseded interfaces are historical context. |
| [Category rules](category-rules.md) | The authoritative specialized categorization contract. |
| [Staging](staging.md) and [data handling](../data/README.md) | Operational and recovery procedures. |
| [AGENTS.md](../AGENTS.md) | The required development workflow and authorization boundaries. |

Current explicit owner instructions take precedence. Apply current accepted decisions and specialized contracts when interpreting this specification. Source code establishes what exists; it does not silently override a requirement. Record discrepancies and resolve them within the authorized task before changing behavior. A specification is not permission to import data, migrate storage, introduce an external integration or publish a service.

**Evidence language:** “Current” below means there is an implementation and associated verification surface in the repository. Acceptance criteria are requirements, not a claim that every browser, real-data or recovery check was run when this document was written. “Deferred” means target scope requiring its own specification increment and authorization before implementation.

## 2. Product scope

| Capability | Current scope | Boundary |
| --- | --- | --- |
| Accounts and positions | Owned account/card identities, bank/cash balances, dated manual positions, history | No complete estate or debt coverage claim. |
| Ingestion | Supported bank files, manual monthly positions, explicit captured crypto observations/history | No automatic bank synchronization or generic file mapper. |
| Processing | Deduplication, classification, evidence-based matching, costs and valuations | Missing evidence stays unresolved. |
| Report workspace | Overview, budget, trips/events, purchases, operations and cash | Local website with owner-only private mobile access. |
| Corrections | Categories, names, notes, operation types, splits, payment links and undo | Imported originals remain immutable. |
| Planning | Category budget schedules and collection budgets | Plans never create transactions. |
| Investments | Captured NEAR/Ethereum observations and explicitly evidenced historical estimates | Full broker/crypto transaction accounting is deferred. |
| Debts, subscriptions and goals | Existing expense/category evidence can be inspected | Dedicated management workflows are deferred; see section 11. |

The processing core must work independently of an initialized website. Website reads consume existing evidence and report projections; they do not run acquisition, imports, rematching, categorization or valuation refresh.

## 3. Domain and evidence model

These are logical contracts, not a request for new database tables. Current workspace schemas are in [model.ts](../src/server/workspace/model.ts); encrypted persistence is implemented by [store.ts](../src/server/workspace/store.ts).

| Entity | Required meaning and relationships |
| --- | --- |
| Account / instrument | Stable owned-account identity, provider, ownership scope, currency and type. Several cards can refer to one account. Ownership requires evidence or an explicit decision. |
| Source artifact / record | Immutable original bytes, content hash, parser/source provenance and a result for each relevant source row. |
| Ledger entry | Stable identity, source references, account/instrument binding, original date/amount/currency and classification provenance. Corrections do not replace original fields. |
| Balance / manual position | Amount, currency, observation precision, eligibility date, source and conflict status. A monthly observation is not a day-precise balance. |
| Movement group / leg | One confirmed economic movement with its evidence-linked debit, credit and cost legs. A ledger entry belongs to at most one movement group. |
| Cost / valuation | Distinct kind, input evidence, calculation, currency and dated rate source. Reference FX estimates remain separate from observed exchange rates. |
| Category assignment / rule | Stable category meaning and provenance; manual and confirmed decisions outrank automatic fallback. Private matching descriptors stay encrypted. |
| Workspace report | Versioned immutable projection with rows, monthly aggregates, coverage, source hashes and ledger fingerprint. It is derived from canonical evidence. |
| Workspace state / history | Revisioned overlay for budgets, category names, row corrections, splits, collections and cash expenses; before/after history supports the defined undo operation. |
| Collection / payment | Trip, event or purchase that references payments, optional budget and descriptive evidence. A reference price is not a payment. |
| Cash expense | Explicit native-currency expense on an existing personal cash account, dated EUR valuation and user-entered category/description. |
| Crypto observation / history | Wallet identity, capture time, source/evidence hashes, NAV/components and optional explicitly confirmed historical quantity assumptions. |

### INV — Financial invariants

- **INV-01: Immutable evidence.** Preserve original imports and source fields. Normalized records, derived state and user decisions retain provenance and are independently auditable.
- **INV-02: One economic contribution.** Duplicate imports, cards, account/manual-position representations, movement legs, refunds, splits and collection links must not multiply a transaction or asset.
- **INV-03: Unknown is not zero.** Missing balances, currencies, dates, rates, ownership, coverage and matches stay explicit. A user-asserted opening balance is labelled as an assumption, not bank evidence.
- **INV-04: Exact money.** The core uses signed minor units with exact arithmetic. Workspace EUR values are integer cents within validated safe bounds. Decimal rates and quantities must not create floating-point accounting drift.
- **INV-05: Facts and plans differ.** Budgets, goal targets, workbook totals, cached formulas, order/reference prices and planned payments do not create assets or transactions.
- **INV-06: Corrections survive.** Reimport and report refresh preserve compatible manual decisions, budgets, links and notes. Conflicts and orphaned references stop the affected operation instead of dropping edits.
- **INV-07: Bounded authority.** UI annotations and AI categories cannot establish account ownership, invent financial legs, resolve reconciliation conflicts or infer missing rates and fees.
- **INV-08: Recovery precedes bulk writes.** A verified non-empty, recoverable backup precedes imports, migrations, bulk reconciliation and protected operator changes. A failed operation must not leave partial accepted financial state.

## 4. Functional requirements

### ING — Acquire and normalize evidence

- **ING-01:** Support the source-specific file adapters for PrivatBank personal/FOP, monobank, Erste, Wise and Revolut. Parse supported CSV/XLS/XLSX formats without evaluating formulas. An unsupported file or conflicting identity is rejected explicitly.
- **ING-02:** Preview before a committed import; show safe processing outcomes and require the established explicit commit/binding controls. A filename or counterparty name never proves account ownership. Wise/Revolut exports without owned-account identifiers require explicit binding to the existing account.
- **ING-03:** Preserve artifact bytes and row provenance. Every source row receives an explicit processing disposition. Repeated/overlapping evidence adds provenance without duplicating the canonical movement; incompatible observations create a visible conflict.
- **ING-04:** Manual workbook imports retain workbook/cell provenance and month precision. Only supported direct position observations contribute. Formulas, totals and planning cells remain non-transaction evidence. Linked bank/manual/cash representations contribute once; an unresolved conflict is not settled by choosing the newest file.
- **ING-05:** Explicit processing coordinates evidence recovery, classification, matching, cost calculation, categorization and report refresh. Repeating an unchanged derivation must reach a stable result and retain manual corrections. Page reads never trigger this pipeline.

### MOV — Money movement and reconciliation

- **MOV-01:** Recognize evidence-supported own transfers, business-owner draws, bank/cash movements and FX. These are movements, not duplicate personal income/spending.
- **MOV-02:** Match eligible records globally with deterministic evidence and uniqueness checks. Confirm hard-evidence or uniquely supported pairs; weak/ambiguous candidates stay unconfirmed. Do not assign an invented lineage to pooled funds.
- **MOV-03:** Keep all relevant legs, including separately posted fees. Link a fee once and satisfy the applicable currency/conservation equation. Provider-described FX may have an explicit aggregate source pool when the statement proves the exchange but no matching source debit exists.
- **MOV-04:** Preserve undated evidence until an unambiguous source match or user clarification establishes its date. Keep missing counterpart legs, discontinuities and unexplained residuals distinct. “Processing finished” must not imply “every movement reconciled.”

### CAT — Categories and exact operation corrections

- **CAT-01:** Apply the versioned [category policy](category-rules.md) across imports, reclassification and report refresh. Preserve the current distinction between purchases/home goods, health/beauty, gifts, transport, travel and refunds. Stable internal identifiers may retain historical names while visible labels use the accepted taxonomy.
- **CAT-02:** Support a display name for a category across periods and exact operation name, note and category overrides. Category renaming changes presentation, not identity, amounts or links. Reject conflicting category names and invalid references.
- **CAT-03:** Support the operation types `expense`, `cash_fx`, `fx` and `excluded`. An exact confirmed currency purchase leaves spending/budget totals but does not itself create cash, ownership, a rate, a fee or a matching leg. Never classify FX from amount alone.
- **CAT-04:** A linked refund follows its purchase's category/exclusion and keeps its negative sign, including across months. Unallocated refunds remain separately explained. Never count both a dated refund and an aggregate adjustment for the same refund.
- **CAT-05:** Manual and confirmed rules retain precedence during repeated processing. Merchant capture stores only unambiguous, authorized matching evidence in encrypted local storage; conflicting descriptors do not establish a general merchant rule.

### SPL — Mixed payments

- **SPL-01:** Split an eligible, unlinked native-currency debit into stable parts. Each part has an ID, description, native amount, category, expense/unresolved disposition and optional purchase link. The source debit remains visible as evidence and is excluded from summed child expenses.
- **SPL-02:** Parts use the source currency and sum exactly to the native debit. Allocate the existing EUR report valuation deterministically across parts so the allocated total equals the parent valuation. Allocation is not evidence of an actual FX acquisition rate.
- **SPL-03:** Reject incompatible currencies, incorrect sums, conflicting parent links and unsupported refund-linked/excluded parents. Unresolved parts remain outside confirmed expenses. Save, cancel, edit, remove and undo preserve the original debit and avoid parent/child double counting.

### CAP — Accounts, cash positions and capital

- **CAP-01:** Show each known position with native/report amount, account identity, observation date/precision, source and valuation status. Preserve negative bank balances as liabilities; negative calculated cash is an unresolved inconsistency, not invented debt.
- **CAP-02:** The current overview capital scope includes personal Erste, Wise, Revolut and ZEN positions, personal cash and eligible crypto. PrivatBank, monobank and FOP remain in full financial processing and income/spending/movement reports. The capital card, holdings, relevant chart and print representation must use the same selected scope.
- **CAP-03:** The period determines the capital cutoff: selected month/year/range end capped at today; full-history and current trailing-month views resolve to the current date. Do not include later observations in historical capital. Current cash-entry hints may use the separately returned current capital and must be labelled accordingly.
- **CAP-04:** Manual monthly observations become eligible at the explicit month-end boundary. Known subsequent cash movements are applied with respect to the relevant balance anchor. Never subtract a manual expense again when a later balance already includes it. Missing/conflicting accounts and rates keep the subtotal explicitly partial.

### CRY — Captured crypto and historical estimates

- **CRY-01:** Import explicitly captured NEAR/Ethereum observations with source identity, evidence hashes, time and reconciled NAV/components. One wallet contributes once; components explain its NAV. No wallet keys, signing or browser-triggered explorer requests are part of this feature.
- **CRY-02:** Historical reconstruction requires confirmed holding eligibility, a declared quantity basis and dated public price evidence. Use the specified monthly opening price at 00:00 UTC on the first day and the same-month EUR/USDT conversion. Unknown quantity, LP composition or price remains unvalued; missing monthly quotes are not filled with current prices.
- **CRY-03:** An observed wallet valuation replaces its historical estimate only when eligible at the selected date. Preserve observed NAV separately from estimates and explain unpriced components. Full investment transactions, staking-income accounting and automatic synchronization remain deferred.

### CASH — Daily cash expenses

- **CASH-01:** Provide a dedicated cash chapter with current recorded balances by currency, dated cash expenses, trends and manual monthly observations. The add-expense action belongs in this chapter.
- **CASH-02:** Require positive native amount, existing personal cash account, date and category; description is optional. Support EUR, USD and UAH. Reject future dates, dates before an asserted cash opening, invalid accounts and invalid categories. New account creation is outside this form.
- **CASH-03:** Save native money plus a dated EUR valuation. EUR uses identity conversion; other currencies use an eligible cached ECB/NBU rate no more than seven days old under the current cash operator contract. Missing/invalid rates stop the write; the form never fetches a rate. Metadata-only edits preserve the previously accepted valuation.
- **CASH-04:** Create, edit, delete and undo an expense through encrypted revisioned state. It contributes once to spending and the applicable cash balance. Creating from Cash remains in Cash at the expense month; editing from Operations returns to its cash list. An ordinary expense needs no collection.

### PER — Time, coverage and comparisons

- **PER-01:** All chapters share a compact, stable calendar with full history, current/previous month, current/specific year, specific month, trailing 12 months and inclusive month ranges. Full history is the initial state without a URL period. Show actual boundaries, partial coverage and absent months.
- **PER-02:** Trailing 12 months means the server's current calendar month plus 11 preceding months, not 365 days or a window anchored to the latest import. Calendar-month core reads use inclusive start and exclusive next-month start; visible/report date ranges have inclusive end dates.
- **PER-03:** Prior-period comparisons use the relevant month or year-shifted comparable window and identify both ranges. The separate annual comparison supports calendar years and two consecutive day-bounded 12-month windows through a selected date. Handle leap days explicitly.
- **PER-04:** Missing statement history and partial/manual-only coverage are not zero income or complete years. Do not fabricate dates for month-only payments/refunds. Suppress totals or percentages when the comparison cannot be supported; percentage change requires a meaningful nonzero baseline.

### OVR — Overview, costs and savings

- **OVR-01:** Show compact dated capital and holdings, income, personal spending, tax/bank/FX costs, income remainder, savings explanation and trends. Relevant amounts open their supporting detail. Keep the overview consistent with the selected period and report corrections.
- **OVR-02:** Keep tax, statement-proven bank fees, confirmed costs, FX estimates and unexplained differences separately identifiable in detail. The displayed combined cost line includes FX only when available and discloses missing FX. Its percentages use income as the stated denominator.
- **OVR-03:** Explain savings from account balances before the period and at its endpoint, decomposing EUR change into retained money and revaluation. Reconcile against income remainder, money retained on excluded operating accounts and unassigned movements. Show unknown accounts and residual differences; never relabel a residual as spending or proven savings.

### BUD — Category budgets and annual plans

- **BUD-01:** Show actual spending by category, descending by default, with linked operations, a visible monthly budget and the total plan for the selected period. One month shows its plan; several covered months show an explicitly labelled monthly average plus the period total. This information must remain visible on mobile.
- **BUD-02:** Edit all periods for a category independently of the upper calendar. Each has an inclusive `from` month, optional inclusive `to` month and nonnegative monthly limit. Reject overlaps and reversed ranges. Add/remove periods and save the full list as one reversible change; propose a calendar year for a new row.
- **BUD-03:** Preserve legacy effective-month limits until explicitly saved as periods. Once a category has an explicit schedule, months outside it have no limit. Deleting every period must not resurrect the initial budget. Refresh, restart and undo retain these semantics.
- **BUD-04:** Annual budgets sum all 12 monthly limits, even when spending data is incomplete. Annual monthly plan is annual plan / 12. Show available actuals and coverage; final variance and monthly actual require a completed, fully covered year. Compare two independently selected years by category without turning absent actuals into zero.
- **BUD-05:** The trip summary shows the travel category's period plan, independently of the filtered trip list; it does not sum individual trip budgets. Purchase summaries retain their collection budgets. A planned trip or purchase does not increase spending, create income or imply that funds were set aside.

### COL — Trips, events and large purchases

- **COL-01:** Create/edit/delete collections with stable ID, kind, name, start/end, optional budget, note, date precision, payment links and coverage information. End is not before start. Future events may be planned; future actual manual payments are rejected.
- **COL-02:** Group trips by completion year and keep historical/seasonal contexts navigable. Distinguish actual purchase cost, bank equivalent, refunds, payments by others and deposits. Others' payments and deposits do not become the owner's trip spending. Historical collection-only payments do not invent income/tax coverage for that period.
- **COL-03:** A payment can annotate a purchase and a trip while contributing once to financial totals. Reject conflicting memberships within the same collection domain. A manual payment must not coexist with a linked bank debit representing that same purchase; source/reference prices never substitute for missing payment evidence.
- **COL-04:** Purchases retain descriptive items, quantities when known, source titles/references and original reference prices independently of payments. Show primary operation/purchase totals in report EUR; native amounts and acquisition/reference evidence remain available in detail.
- **COL-05:** Derive purchase link status from evidence: `matched`, `unmatched`, `review` or `cash`, with a separate amount-verification result. A link alone is not proof that an order total matches. Missing/shared rows, unknown orders, unavailable amounts or merchant/amount mismatches remain reviewable.
- **COL-06:** Archive and restore purchases reversibly. The normal list excludes archived items; the archive can find them across reporting periods and retain search, details and links. Archiving does not exclude their transactions from spending or delete evidence.

### UX — Operations, navigation, privacy and printing

- **UX-01:** Operations supports private search, category/type filters, progressive list loading and drill-down into exact evidence. Distinguish spending, refunds, cash, FX, exclusions and unresolved purpose. Searching/filtering never modifies source records.
- **UX-02:** In-app and browser Back/Forward restore the previous chapter, period, filters, drill-down and scroll. Confirm discarding unsaved forms. Keep private navigation snapshots in tab memory; browser history stores only opaque stamps and safe section/period URL values. Reload restores safe URL context, not persisted financial search text.
- **UX-03:** Provide a persistent hide-amounts preference. Mask financial text and applicable accessibility labels, tooltips and fields while preserving values for calculations. Persist only the non-sensitive boolean preference. This is visual privacy, not an encryption or access-control boundary.
- **UX-04:** Printing uses the selected period, relevant scope and current saved corrections. Trip/purchase print detail preserves coverage and the difference between source prices and bank equivalents. Use the browser print/PDF flow; no external export service is required.
- **UX-05:** Use the current Ukrainian interface and EUR presentation consistently. Forms need labelled inputs, usable keyboard focus, visible validation and a recoverable cancel path. Verify desktop and narrow mobile layouts at the affected surface; do not infer accessibility or responsive acceptance from source tests alone.

## 5. Calculation contracts

All formulas use the same selected scope, date coverage and correction revision. Missing inputs must be disclosed. Display rounding must not change stored cents or financial membership.

| Quantity | Contract |
| --- | --- |
| Net expense | Sum eligible corrected expense/refund rows, with the defined legacy undated-refund adjustment applied once. Movement, excluded, unresolved split and collection-only records do not silently enter confirmed period spending. |
| Period budget | Sum each category's applicable monthly limits for the report's included months. Separate this from the full annual plan. |
| API income remainder | Income − net expense − tax − bank costs. The current `remainder` field is before FX. |
| Displayed income remainder | API remainder − available FX estimate. If FX is missing, disclose that the remainder excludes an unknown FX component. Missing FX is never asserted to be zero cost. |
| Known capital | Sum eligible valued positions and wallet NAV once, reflecting known bank liabilities. Identify missing/unpriced coverage rather than presenting a complete estate valuation. |
| Account EUR change | Ending EUR position − starting EUR position. Missing endpoints leave the change unknown. |
| EUR revaluation | Starting native position valued at ending eligible rate − starting EUR valuation, with exact currency-scale handling. |
| Money retained | Account EUR change − EUR revaluation. |
| Expected savings | Income remainder after available FX − retained money on excluded operating accounts − unassigned movements. Unknown account/FX coverage remains explicit. |
| Savings residual | Known retained money in savings scope − expected savings. It is unexplained until evidence resolves it. |
| Collection net | Eligible paid amount − recovered amount under the collection's defined amount basis; report/bank equivalents remain distinguishable from original purchase prices. |
| Annual variance | Complete-year actual − annual plan. No final variance for incomplete years. |
| Percentage change | (Current − previous) / previous × 100, only with comparable evidence and a valid positive baseline in the current expense comparison contract. |
| Split conservation | Sum(native parts) = original native debit; sum(allocated EUR parts) = original EUR valuation. |

The core supports UAH/EUR/USD valuation; the current website is EUR-only. Adding a website currency selector requires an explicit requirement increment covering all amounts, persisted inputs, rounding and printing together.

## 6. Local HTTP and mutation contract

The [HTTP adapter](../src/server/workspace/http.ts) is a private website transport, not a public integration API. Preserve the existing native Node service and framework-independent core.

| Method / path | Contract |
| --- | --- |
| `GET /healthz` | Serving status and release identifier. Not evidence of complete data coverage or browser acceptance. |
| `GET /api/workspace` | Current revision, report/statement coverage, calendar, overlay, effective rows, collection totals/link audit, cash context, CSRF token and source-current indicator. |
| `GET /api/period?period=…` | Period summary/comparison, revision, capital at cutoff and separately labelled current capital. Accepted periods include `all`, `last12`, `YYYY`, `YYYY-MM`, `YYYY-MM..YYYY-MM`. |
| `GET /api/savings?period=…` | Dated savings decomposition and residuals for that period. |
| `GET /api/budget-years` | Annual plans, available actuals and coverage-qualified results. |
| `GET /api/annual-comparison` | `mode=calendar&year=…` or `mode=trailing&asOf=YYYY-MM-DD`; explicit current/previous ranges and comparability. |
| `GET /api/capital-history` | Dated bank/cash and eligible crypto history with missing/unpriced counts. |
| `GET /api/history` | Latest 30 revision/action/time entries. Financial before/after payloads remain in encrypted storage. |
| `POST /api/change` | Validated mutation with `action`, current `revision` and action-specific fields; returns the accepted next revision. |

Current mutation actions: `budget`, `budgetPeriods`, `row`, `categoryName`, `collection`, `deleteCollection`, `operationSplit`, `cashExpense`, `deleteCashExpense`, `undo`. Their typed schemas, optional fields and bounds are authoritative in [model.ts](../src/server/workspace/model.ts), [cash-expenses.ts](../src/server/workspace/cash-expenses.ts) and [operation-splits.ts](../src/server/workspace/operation-splits.ts).

- **API-01:** Require the correct session for workspace APIs. Enforce exact Host/Origin and same-origin request rules; writes also require CSRF token and JSON content type. Allow only named static assets, never arbitrary file paths.
- **API-02:** Validate bounded input before mutation. The current body limit is 128,000 bytes; request/header timeouts are 10 seconds. Return safe error codes without raw database errors or financial payloads in logs.
- **API-03:** A stale revision returns HTTP 409 `REVISION_CONFLICT` and changes nothing. Serialize writes and commit overlay/history atomically; one rejected write must not break later valid requests.
- **API-04:** Undo reverses the latest eligible user action by creating another history revision. It is not arbitrary historical restore, redo or financial rollback. Do not undo a report refresh or an undo action through this endpoint.
- **API-05:** Existing source-fingerprint checks expose report staleness detected at startup. Reloading a page does not regenerate the report. An explicit protected refresh checks compatibility and rejects orphaned edits.

## 7. Persistence, security and privacy

- **SEC-01:** Keep the canonical database in SQLCipher. Keep database/recovery keys in the established macOS Keychain/recovery flow; key bytes never enter arguments, environment variables, images, plaintext files or logs. Preserve parameterized queries and exact integer/decimal handling.
- **SEC-02:** Financial statements, artifacts, reports, exports, backups, merchant inventories and runtime state stay in ignored local storage. Use only deliberately synthetic fixtures in source control. Vault receives project metadata only.
- **SEC-03:** Website reads are offline and have no telemetry, external assets or bank/AI calls. Application egress remains deny-by-default. An allowed host does not by itself authorize a new data flow or credential use.
- **SEC-04:** The only approved AI use is opt-in categorization through existing Codex sign-in: bounded sanitized merchant label and allowed category codes only. Never transmit dates, amounts, raw descriptions, names of counterparties, account/card IDs, references, balances or totals. AI cannot match movements or calculate money.
- **SEC-05:** Preserve the pinned, ephemeral categorizer invocation with user configuration ignored, read-only sandbox, no approvals, web, apps/plugins/hooks/memory, empty temporary working directory and empty shell-tool environment. MoneyWave must never read or store the authentication token. Failure leaves eligible expenses pending without blocking imports.
- **SEC-06:** Serve locally on loopback. The optional private stage requires the configured owner's Tailscale identity, validated proxy/host/origin and secure session cookie. Tailscale transport alone is not authorization. No public endpoint, Funnel or container registry publication is part of this specification.
- **SEC-07:** Do not persist financial data or private navigation/search state in browser storage. The presentation-only hide-amounts boolean is the accepted exception. Use no-store responses, restrictive CSP, clickjacking protection and no-referrer behavior.

## 8. Operations and recovery

- **OPS-01:** Run the pinned Node 24 / TypeScript / pnpm processing stack, SQLCipher, local static website and native HTTP adapter. Do not introduce a separate service, database or framework without an actual requirement and approved architecture change.
- **OPS-02:** Initialization, report refresh, imports and analysis are explicit operator tasks. Validate source compatibility and a recoverable backup first; record safe outcome codes and itemized private before/after evidence locally. Stop on unexplained loss or reconciliation differences.
- **OPS-03:** A stage release uses an immutable local container image and its matching host broker. Source edits alone do not update the running stage. Preserve the previous image and broker for code rollback.
- **OPS-04:** Host and stage share the existing macOS SQLCipher store through the host query broker. Never mount the database across the macOS/Linux boundary or seed, copy over or migrate it during a release. The key remains on the host; Docker attach logging is disabled for the query channel.
- **OPS-05:** Keep non-root/read-only container restrictions, loopback publishing, restricted bridge traffic and owner-only Serve mapping. Launchd reconnects after container restart. Mac availability, login and Keychain access remain operational prerequisites.
- **OPS-06:** Stage completion requires passing relevant verification, verified backup/schema, synthetic host/container read/write checks, unchanged real-data readback, matching served asset/release versions, browser interaction and restart recovery. Report serving health, data acceptance and browser acceptance separately. Follow [staging.md](staging.md) for exact commands and rollback.

## 9. Quality and failure behavior

- **QUA-01:** Repeated imports/derivations and no-op refreshes preserve stable financial meaning and manual decisions. Validate deduplication, equation conservation and reference integrity with exact comparisons.
- **QUA-02:** Empty, loading, missing-rate, uninitialized, stale-report, invalid-period, conflict and failed-write states must be distinguishable. No fallback may replace a missing financial fact with a believable invented number.
- **QUA-03:** Mobile navigation, budget labels, dialogs, overflow, keyboard use and printing require affected-surface verification. Static source assertions and unit tests are supporting evidence, not a substitute for rendered acceptance.
- **QUA-04:** Keep financial validation local. Real-data checks are opt-in, read-only unless mutation is explicitly authorized, and must not echo private records. Tests of writes use isolated synthetic storage.
- **QUA-05:** No numeric latency, scale, accessibility-conformance, RPO or RTO guarantee is currently established. Record measured conditions before introducing such a target; do not claim an unmeasured service level. In-memory workspace projections must be reconsidered with measured evidence if data size becomes a constraint.

## 10. Acceptance and traceability

Each row is a required scenario, not a historical pass result. For a change, name the affected IDs and retain evidence for the exact code/runtime under review. Extend existing tests when behavior changes; avoid tests that only repeat implementation text.

| Acceptance ID | Scenario and required outcome | Existing verification surface |
| --- | --- | --- |
| AC-01 | Import the same/overlapping source twice: canonical entries are unchanged, provenance is retained; conflicting immutable fields remain explicit. | [Import repository](../tests/server/import-repository.test.ts), [import service](../tests/server/import-service.test.ts); ING, INV |
| AC-02 | Link monthly manual evidence to a bank/cash position: it contributes once, keeps month precision and rejects conflicting observations. | [Manual positions](../tests/server/manual-positions.test.ts), [capital](../tests/server/finance-centers.test.ts); ING, CAP |
| AC-03 | Reconcile transfers with extra fee legs and repeat processing: legs are unique, costs count once and the result reaches a fixed point. | [Reconciliation](../tests/server/autonomous-reconciliation.test.ts), [fixed point](../tests/server/reconciliation-fixed-point.test.ts), [costs](../tests/domain/cost-engine.test.ts); MOV |
| AC-04 | Rate/date/ownership is absent or ambiguous: retain unresolved evidence, suppress unsupported totals and never assume parity or ownership. | [Undated evidence](../tests/server/undated-reconciliation.test.ts), [valuation](../tests/server/valuation-service.test.ts); INV, MOV |
| AC-05 | Correct a category/FX exclusion, refresh twice and receive a later linked refund: exact decisions and negative refund semantics survive without altering source money. | [Category policy](../tests/server/category-policy-v2.test.ts), [operation types](../tests/server/workspace-operation-type.test.ts), [workspace](../tests/server/workspace.test.ts); CAT |
| AC-06 | Split a native debit, link parts and undo: native/EUR totals conserve, unresolved parts stay excluded, the parent is not counted twice and invalid splits fail atomically. | [Splits](../tests/server/operation-splits.test.ts); SPL |
| AC-07 | Select historical capital before a later bank/crypto observation: later facts are excluded, manual eligibility and partial valuation remain visible. | [Capital](../tests/server/finance-centers.test.ts), [crypto history](../tests/server/workspace-crypto-history.test.ts); CAP, CRY |
| AC-08 | Save/edit/delete/undo a cash expense around a confirmed balance anchor: spending and cash change once; future dates and unavailable FX fail without mutation. | [Cash expenses](../tests/server/workspace-cash-expenses.test.ts), [cash history](../tests/server/workspace-cash-history.test.ts); CASH |
| AC-09 | Open with no period, then select a month range and trailing year with sparse data: boundaries use server time and coverage remains explicit. | [All history](../tests/server/workspace-all-period.test.ts), [month range](../tests/server/workspace-month-range.test.ts), [rolling periods](../tests/server/workspace-rolling-period.test.ts); PER |
| AC-10 | Compare partial years, leap-date windows and undated aggregate refunds: unsupported comparisons are unavailable rather than zero or misleading percentages. | [Annual comparison](../tests/server/workspace-annual-comparison.test.ts), [period comparison](../tests/server/workspace-period-comparison.test.ts); PER |
| AC-11 | Set bounded category periods, reject overlaps, remove them all and refresh/undo: outside periods has no limit and the baseline does not reappear. | [Budget periods](../tests/server/workspace-budget-period.test.ts); BUD |
| AC-12 | Read one/multiple months on desktop/mobile and compare annual plans: distinguish monthly average, selected-period total and full annual plan; incomplete actuals have no final variance. | [Budget years](../tests/server/workspace-budget-years.test.ts), [monthly visibility](../tests/web/budget-monthly-visibility.test.ts), rendered browser checks; BUD |
| AC-13 | Decompose income, costs, FX and savings: visible equations reconcile, FX percentages use income and unknown account endpoints remain visible. | [Savings](../tests/server/workspace-savings.test.ts), [FX percentages](../tests/web/fx-percentage.test.ts); OVR |
| AC-14 | Add a trip/purchase link and an attempted duplicate manual payment: payments count once, others/deposits remain separate, historical collection payments do not create statement coverage; filtering trips preserves the category budget. | [Trips](../tests/server/workspace-trips.test.ts), [purchases](../tests/server/workspace-purchases.test.ts), [history scope](../tests/server/purchase-history-scope.test.ts), [trip budget](../tests/web/trip-category-budget.test.ts); COL, BUD |
| AC-15 | Inspect a purchase with missing/mismatched evidence, then archive and restore it: status is honest, report currency consistent, archive retains links and leaves spending unchanged. | [Link audit](../tests/server/purchase-links.test.ts), [report currency](../tests/web/purchase-report-currency.test.ts), [archive](../tests/web/purchase-archive.test.ts); COL |
| AC-16 | Navigate category → operation → Back/Forward with filters, scroll and an unsaved form: context restores, discard is explicit, private state is absent from persistent history/URL. | [Navigation](../tests/web/navigation.test.ts), rendered browser checks; UX |
| AC-17 | Hide amounts, navigate, open/edit a form and print: masking remains effective while arithmetic/form values remain unchanged; only the preference persists. | [Privacy](../tests/web/privacy.test.ts), rendered browser/print checks; UX, SEC |
| AC-18 | Two clients write the same revision: accept one, return conflict for the stale write, preserve atomic history and allow a later valid write/eligible undo. | [Workspace](../tests/server/workspace.test.ts); API |
| AC-19 | Refresh a report that would orphan a saved correction or split: reject it and retain the preceding report/state. Compatible refresh preserves edits and cash facts. | [Workspace](../tests/server/workspace.test.ts), [splits](../tests/server/operation-splits.test.ts), [cash](../tests/server/workspace-cash-expenses.test.ts); API, INV |
| AC-20 | Request with invalid Host/Origin/session/CSRF, oversized input or unauthorized network target: deny safely without financial mutation or sensitive errors. | [Workspace](../tests/server/workspace.test.ts), [security boundary](../tests/server/security-boundary.test.ts), [private build](../tests/server/private-build-boundary.test.ts); SEC, API |
| AC-21 | Categorize with synthetic input and simulate unavailable AI: only approved fields/invocation are permitted; imports survive with pending categorization. | [Categorizer](../tests/server/codex-categorizer.test.ts), [automatic categorization](../tests/server/autonomous-categorization.test.ts); SEC, CAT |
| AC-22 | Deploy/restart/roll back a candidate: verify host/container transactions, unchanged real records, serving versions and owner browser recovery. | [Container runtime](../tests/server/container-runtime.test.ts), [channel verifier](../scripts/verify-stage-channel.ts), [staging runbook](staging.md); OPS |

### Verification commands and limits

- `pnpm verify`: lint, typecheck, synthetic tests and repository security checks under Node 24.
- `pnpm verify:real-data`: separately authorized local checks with safe result codes; not evidence of a data mutation or complete reconciliation.
- `pnpm verify:codex-subscription`: separately authorized external acceptance using synthetic text.
- `pnpm stage:deploy` / `pnpm stage:status`: stage deployment/status under the existing standing application-release authorization; browser and restart evidence remain separate.
- `pnpm analyze:finance` and `pnpm analyze:privatebank` are mutating operators, not documentation checks or read-only tests.

For documentation-only changes, inspect each diff, validate paths/anchors and requirement references, check ignored-sensitive paths and whitespace, and verify the committed/pushed artifact. Application, financial and release claims require the additional affected-surface evidence.

## 11. Deferred full-hub capabilities

These define the remaining product boundary, not implementation authorization or delivery dates. Existing account, ledger, provenance, privacy and exact-money contracts apply to every future increment.

| Future ID | Required product outcome | Acceptance boundary and decisions needed before implementation |
| --- | --- | --- |
| FUT-SYNC | Repeated authorized source acquisition → preview/import → reconciliation → report refresh while preserving corrections. | Prove provider access, exact scopes, cursor/retry/deduplication behavior, credential storage, rollback and conflict handling per provider. No generic “all banks connected” claim. |
| FUT-INV | Account/instrument holdings, transactions, cash, fees, investment income and sourced valuation; explain portfolio changes and realized/unrealized results. | Specify broker formats/access, instrument identity, corporate actions, lot/cost-basis rules and quote freshness. Link transfers once; reject missing prices and unsupported accounting. IBKR integration remains unimplemented. |
| FUT-CRYPTO | Crypto transaction/fee/reward and transfer accounting across explicitly owned wallets, supplementing captured NAV. | Establish chain/source coverage, ownership and quantity reconciliation; avoid counting tokens both in wallet NAV and as separate assets. No signing/trading authority is implied. |
| FUT-DEBT | Dated liabilities, outstanding principal, evidence-backed interest/fees, repayments and schedules in the owner's finance picture. | Define debt types, opening evidence, currency and accrual rules. Link real repayments; planned installments are not transactions. Incomplete liabilities prevent complete net-worth claims. |
| FUT-SUB | A confirmed inventory of recurring obligations with provider, amount/currency, cadence, next expected charge and linked actual expenses. | Recurrence suggestions need confirmation. Forecasts must not create expenses. Cancellation/provider-account actions require separate explicit authorization. Existing category breakdowns are not subscription management. |
| FUT-GOAL | Named goals with target amount/currency/date, allocation plan and progress based on existing assets or explicit contributions. | Define earmarking and overlapping-goal behavior. A goal is not another asset or transaction. Show assumptions and prevent duplicate allocation from implying additional wealth. |
| FUT-NET | A complete net-worth view combining supported assets and liabilities, with a sourced change bridge. | Agree estate coverage, valuation policies and included scopes. A current known-position subtotal must retain its partial label until coverage is evidenced. |
| FUT-REPORT | Additional report currencies, forecasts and export formats built from the same corrected evidence. | Define rounding, scenario assumptions, private output location and data included. Preserve source/report currency distinctions; no unrequested cloud publication. |

**Not in the accepted product direction:** multi-user tenancy, shared household roles, SaaS billing, public dashboards, cloud financial storage, opaque AI reconciliation, automated trading or a new general integration platform. Reconsider only through a specific owner request and explicit architecture/privacy decision.

## 12. Spec-driven change protocol

1. Read the affected requirements, this specification and specialized contracts. Identify the requirement and acceptance IDs that the task changes.
2. Before application code, write the intended behavior, scope/non-goals, inputs/outputs, invariants, failure cases and acceptance evidence. Update this file for a small change; use a linked focused specification for a larger increment.
3. Resolve material ambiguity around finance, persistence, security, external access or irreversible actions. Existing authorization remains valid; routine implementation choices do not require a separate approval ceremony.
4. Implement the smallest coherent change and verify the affected behavior. Preserve unrelated work and immutable evidence.
5. Review code and specification together. Record coverage gaps honestly; never weaken an agreed requirement merely to make a test pass or rename an incomplete feature “done.”
6. Update the specification/status and relevant decision record in the same change. Report the implemented IDs, verification and remaining gaps; commit, push and deploy only within the applicable authorization.

Historical files under `docs/superpowers/` remain historical proposals. A new focused specification must link back to the current requirements and explicitly identify any accepted supersession.

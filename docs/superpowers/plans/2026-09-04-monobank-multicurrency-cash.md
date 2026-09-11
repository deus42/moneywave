# Monobank Multicurrency Cash Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development for every behavior change and superpowers:verification-before-completion before reporting completion. Execute inline on `main`; project policy forbids subagents, worktrees, staging, commits, and pushes without separate authorization.

**Goal:** Import the three local Monobank statements into the encrypted evidence ledger, autonomously reconcile them with PrivatBank, track cash from a zero opening position, apply one category taxonomy, and convert every two-year report and transaction into UAH/EUR/USD.

**Architecture:** Generalize the current import service around provider-aware adapters, add a strict Monobank XLS adapter, materialize official-rate reporting valuations, and extend deterministic classification/matching for MCC, explicit provider fees, external transfers, and cash. Keep raw artifacts immutable, economic movements separate from terminal spending, and all sensitive processing local.

**Tech Stack:** Node 24, TypeScript 5, Next.js 16, React 19, SQLCipher, SheetJS CE, Decimal.js, Vitest, Playwright, ECB Data API, NBU Open Data API.

---

## File Map

- `src/server/import/adapter.ts`: provider-aware adapter descriptor and generic discovery contract.
- `src/server/import/monobank.ts`: legacy XLS parsing, normalization, reconciliation, and source semantics.
- `src/server/import/service.ts`: ordered adapter probing and provider-neutral preview/commit.
- `src/server/import/repository.ts`: provider-neutral account registration and provider fee evidence persistence.
- `src/server/fx/historical-rates.ts`: bounded history loading and date lookup.
- `src/server/fx/valuation-service.ts`: entry/snapshot valuation materialization.
- `src/server/cash/service.ts`: zero-opening cash accounts and evidence-backed cash movements.
- `src/server/categorization/mcc.ts`: versioned MCC-to-category rules.
- `src/server/db/migrations/0011-monobank-valuations-cash.ts`: provider fee evidence, valuations, aliases, and cash opening state.
- `src/server/read-model/repository.ts`: report-currency aggregates and valuation coverage.
- `src/components/*`, `src/app/*`: report-currency UI and transaction evidence presentation.
- `scripts/analyze-finance.ts`: verified one-time import/valuation/reconciliation pipeline with aggregate-only stdout.

### Task 1: Lock provider-aware import contracts

**Files:**
- Create: `src/server/import/adapter.ts`
- Modify: `src/server/import/types.ts`
- Modify: `src/server/import/service.ts`
- Modify: `src/server/import/repository.ts`
- Test: `tests/server/import-service.test.ts`
- Test: `tests/server/import-repository.test.ts`

- [ ] Add failing tests proving a third provider adapter can be probed and committed without a PrivatBank branch.
- [ ] Run `pnpm vitest run tests/server/import-service.test.ts tests/server/import-repository.test.ts` and confirm the provider-generic assertions fail for the missing contract.
- [ ] Introduce `providerCode`, `providerDisplayName`, parser kind/version, discovery, and normalize/reconcile dispatch on the adapter contract.
- [ ] Make registrations provider-aware and reject provider/account conflicts.
- [ ] Run the focused tests and confirm they pass without changing existing Privat behavior.

### Task 2: Implement the Monobank statement adapter

**Files:**
- Create: `src/server/import/monobank.ts`
- Create: `tests/import/monobank.test.ts`
- Modify: `tests/helpers/workbook.ts`
- Modify: `src/server/runtime/services.ts`

- [ ] Add an obviously synthetic legacy-style workbook fixture with statement metadata and the ten observed columns.
- [ ] Add failing tests for format probing, account/instrument discovery, dates, settlement/original amounts, MCC, provider rate, fee, cashback, balance, dedupe, formula rejection, and zero skipped rows.
- [ ] Run `pnpm vitest run tests/import/monobank.test.ts` and confirm failures are caused by the missing adapter.
- [ ] Implement dynamic card-currency headers, strict parsing, HMAC identifiers, row normalization, and balance reconciliation.
- [ ] Register the adapter in runtime services and the generic import service.
- [ ] Rerun the focused adapter and import-service tests to green.

### Task 3: Add storage for fee evidence, valuations, aliases, and cash opening

**Files:**
- Create: `src/server/db/migrations/0011-monobank-valuations-cash.ts`
- Modify: `src/server/db/migrations/index.ts`
- Test: `tests/server/database.test.ts`
- Test: `tests/server/import-repository.test.ts`

- [ ] Add failing schema/readback tests for `provider_fee_evidence`, `ledger_entry_valuations`, `balance_snapshot_valuations`, `category_aliases`, and cash opening metadata.
- [ ] Run the focused database tests and confirm the new tables are absent.
- [ ] Add the numbered strict migration, constraints, foreign keys, uniqueness rules, and indexes.
- [ ] Persist Monobank fee/rate/MCC/cashback source metadata without logging it.
- [ ] Run database and import-repository tests to green, including rollback on invalid fee evidence.

### Task 4: Materialize reproducible UAH/EUR/USD valuations

**Files:**
- Create: `src/server/fx/historical-rates.ts`
- Create: `src/server/fx/valuation-service.ts`
- Modify: `src/server/fx/official-providers.ts`
- Modify: `src/domain/fx-service.ts`
- Modify: `src/server/runtime/services.ts`
- Test: `tests/server/official-fx.test.ts`
- Create: `tests/server/valuation-service.test.ts`

- [ ] Add failing tests for batched NBU/ECB history, last-publication lookup, source priority, identity rates, Decimal half-up rounding, idempotency, and missing-rate coverage.
- [ ] Run `pnpm vitest run tests/server/official-fx.test.ts tests/server/valuation-service.test.ts` and confirm the new behaviors fail.
- [ ] Implement bounded historical loaders and cached date-indexed lookup without transaction payloads.
- [ ] Implement entry and balance-snapshot valuation materialization for UAH/EUR/USD with versioned audit evidence.
- [ ] Rerun focused FX tests to green.

### Task 5: Extend autonomous movements and cash accounting

**Files:**
- Create: `src/server/cash/service.ts`
- Modify: `src/domain/transaction-signals.ts`
- Modify: `src/domain/autonomous-matcher.ts`
- Modify: `src/server/reconciliation/autonomous-service.ts`
- Modify: `src/server/movements/autonomous-cost-service.ts`
- Test: `tests/domain/autonomous-matcher.test.ts`
- Create: `tests/server/cash-service.test.ts`
- Modify: `tests/server/autonomous-reconciliation.test.ts`

- [ ] Add failing tests for cross-provider exact transfer uniqueness, Monobank executed FX evidence, external destination boundaries, zero-opening cash accounts, withdrawal/deposit conservation, and no cash-as-spending behavior.
- [ ] Run the focused matching/cash tests and verify expected failures.
- [ ] Add MCC/description cash signals and evidence-backed synthetic cash legs only for proven withdrawals/deposits.
- [ ] Preserve unmatched Revolut/Wise/Erste-directed outflows as external movements awaiting counterpart evidence.
- [ ] Attach provider fee composition without double-counting settlement amounts.
- [ ] Rerun focused tests to green and verify fixed-point idempotency.

### Task 6: Replace provider categories with one canonical taxonomy

**Files:**
- Create: `src/server/categorization/mcc.ts`
- Modify: `src/domain/personal-categorization.ts`
- Modify: `src/server/categorization/autonomous-service.ts`
- Modify: `src/server/categorization/reclassification-preparation.ts`
- Create: `src/server/db/migrations/0012-canonical-taxonomy.ts`
- Modify: `src/server/db/migrations/index.ts`
- Test: `tests/domain/personal-categorization.test.ts`
- Test: `tests/server/autonomous-categorization.test.ts`
- Test: `tests/server/reclassification-preparation.test.ts`

- [ ] Add failing tests for movement-first classification, MCC priority, provider-label fallback, alias priority, Codex fallback, and versioned reclassification of previous assignments.
- [ ] Run focused category tests and confirm they fail for missing MCC/alias behavior.
- [ ] Add the canonical taxonomy migration and MCC rule table without introducing competing provider trees.
- [ ] Implement the approved precedence chain and preserve provenance for every assignment.
- [ ] Rerun category tests to green.

### Task 7: Convert read models instead of filtering them

**Files:**
- Modify: `src/server/read-model/repository.ts`
- Modify: `src/domain/reporting.ts`
- Modify: `src/lib/presentation.ts`
- Test: `tests/server/read-repository.test.ts`
- Test: `tests/domain/reporting.test.ts`

- [ ] Add failing tests that mixed-native-currency entries all contribute to a selected UAH/EUR/USD report and drill-down totals equal aggregates.
- [ ] Add failing tests for native-currency filtering as a separate option and explicit missing-valuation coverage.
- [ ] Run focused reporting tests and verify the current native-currency filter behavior fails them.
- [ ] Join materialized valuations in overview, timeline, categories, costs, accounts, flow routes, and transaction pages.
- [ ] Preserve native amount/currency beside the selected reporting value.
- [ ] Rerun focused reporting tests to green.

### Task 8: Update the finance cockpit UI

**Files:**
- Modify: `src/components/report-controls.tsx`
- Modify: `src/components/transactions-ledger.tsx`
- Modify: `src/components/transaction-drawer.tsx`
- Modify: `src/components/cashflow-chart.tsx`
- Modify: `src/components/category-breakdown.tsx`
- Modify: `src/components/money-flow-map.tsx`
- Modify: `src/app/page.tsx`
- Modify: `src/app/transactions/page.tsx`
- Modify: `src/app/categories/page.tsx`
- Modify: `src/app/money-flow/page.tsx`
- Modify: `src/app/data/page.tsx`
- Modify: `src/app/globals.css`
- Modify: `tests/e2e/moneywave.spec.ts`

- [ ] Add failing Playwright assertions that the report switcher changes values without hiding native currencies and that each transaction exposes three equivalents/rate evidence.
- [ ] Add failing assertions for Monobank accounts, cash position, category drill-down, linked movements, valuation warnings, and 390px viewport containment.
- [ ] Run the targeted Playwright scenarios and confirm the assertions fail against the current UI.
- [ ] Implement the restrained cockpit changes with report/native currency controls clearly separated.
- [ ] Rerun the targeted browser suite to green with no application console/page errors.

### Task 9: Add the protected real-data pipeline and import Monobank

**Files:**
- Create: `scripts/analyze-finance.ts`
- Modify: `scripts/verify-real-data.ts`
- Modify: `package.json`
- Modify: `docs/product.md`
- Modify: `docs/architecture.md`
- Modify: `docs/decisions.md`
- Modify: `AGENTS.md`
- Test: `tests/server/verified-analysis-run.test.ts`

- [ ] Add failing tests for backup-before-migration/import, three-artifact atomic processing, post-import valuation/category/matching fixed point, safe stdout, and idempotent rerun.
- [ ] Run the focused verified-run tests and confirm failure before the new pipeline exists.
- [ ] Implement `pnpm analyze:finance` with a verified pre-run backup, per-artifact commit backups, integrity checks, and aggregate-only result codes.
- [ ] Update the safe real-data verifier for both PrivatBank and Monobank without printing filenames or financial values.
- [ ] Update project documentation with the approved data flow and exact privacy boundary.
- [ ] Create and verify a non-empty encrypted backup, then run the one-time pipeline against `data/monobank/`.
- [ ] Read back provider/accounts/artifacts/row partitions/valuations/movements/categories/cash state and verify exact invariants.
- [ ] Rerun the pipeline and confirm idempotency without duplicate economic entries.

### Task 10: Full verification and populated UI acceptance

**Files:**
- Review all changed task-owned files.
- Do not stage or commit.

- [ ] Run `pnpm lint` under the project Node 24 runtime.
- [ ] Run `pnpm typecheck`.
- [ ] Run `pnpm test`.
- [ ] Run `pnpm test:e2e`.
- [ ] Run `pnpm verify:security`.
- [ ] Run `pnpm verify:real-data` and confirm safe-only output.
- [ ] Run `pnpm build`.
- [ ] Verify the populated live UI on desktop and approximately 390px mobile across Overview, Money Flow, Transactions, Categories, and Data.
- [ ] Verify report-currency conversion, native amount visibility, transaction FX evidence, cash position, category drill-down, movement expansion, no overflow, and no external browser requests.
- [ ] Review `git diff --check`, allowlisted diffs, `git status --short --branch`, ignore behavior for `data/monobank/`, zero staged files, zero commits, and zero remotes.
- [ ] Record residual evidence gaps precisely and ask only necessary transaction questions in the authorized chat format.

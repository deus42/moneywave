# Manual Position History Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline, task by task. Project instructions prohibit subagents, worktrees and Git mutation without explicit authorization.

**Goal:** Migrate the authorized local workbook's direct position observations into a usable historical Capital view without duplicating the bank ledger.

**Architecture:** Retain the existing encrypted artifact and bank ledger. Add only workbook lineage, batches, cell dispositions, position series and immutable monthly facts. Coalesce series linked to existing accounts; unrelated manual bank positions remain distinct. Source month precision is explicit, with month-end eligibility but no invented observation date.

**Tech Stack:** Existing Node 24, TypeScript, pinned SheetJS CE, SQLCipher, decimal money and Next.js UI.

## Verification targets / stop conditions

- Direct source cells only; formula caches, totals and blank values never create positions. Every populated cell receives a disposition; other workbook domains are explicitly deferred.
- SHA-256 repeated-artifact protection; lineage/series/month/value identity independent of coordinates. Changed values create visible immutable conflicts, not overwrites.
- Reject currency/ownership ambiguity. A linked account contributes once; month-only values do not imply exact-day reconciliation. Manual cash and recorded cash use one logical position.
- Verified encrypted backup before migration/import, atomic rollback, after-import backup and restore verification. Bank tables remain byte-for-byte logically unchanged.
- UAH/EUR/USD valuation reuses official cached evidence only. Missing rates and partial estate coverage stay visible.
- Unit/integration tests plus live desktop/mobile readback, privacy/ignore checks, no staged files or commits.

## Tasks

### 1. Bounded parser and provenance

- [x] Add failing synthetic tests in `tests/import/manual-positions.test.ts`: formulas, zero vs blank, period validation, duplicate period, unsupported currency, inflated formatting, unsupported cells.
- [x] Run focused tests and observe missing implementation failures.
- [x] Implement `src/server/manual/position-workbook.ts` with closed Savings header contract, bounded non-empty cell iteration and safe errors. Reuse pinned application SheetJS, without formula evaluation or workbook rewriting.
- [x] Rerun parser tests and local read-only preview; output only safe codes/structural counts.

### 2. Encrypted import and stable facts

- [x] Add failing SQLCipher tests in `tests/server/manual-positions.test.ts` for repeat/overlap/conflict, cash/account bindings, rollback and unchanged ledger.
- [x] Add migration `0015-manual-position-history.ts` and register required tables.
- [x] Implement `src/server/manual/position-import.ts`: preview, backup gate, atomic artifact/cell/fact persistence, source readback and backup status.
- [x] Add `scripts/import-manual-positions.ts` for the scoped local operator workflow. Default is preview; explicit commit flag writes. No file names, source fields or raw errors in stdout.

### 3. Capital history and source reconciliation

- [x] Add failing read-model tests for month precision/eligibility, stable identity, same-month provider authority, cash coalescing, conflicts and historical currency totals.
- [x] Extend `FinanceCenters` through a focused manual-position reader. Add monthly history using the same capital projection as position drill-down.
- [x] Extend `PositionTable`, Capital page and Data with source cells, date precision, disposition coverage and history selection. Preserve existing UI hierarchy; no new planning destination.
- [x] Run lint/typecheck/unit tests and review changed files before real import.

### 4. Authorized import and real acceptance

- [x] Preflight local file identity and source structure. Verify backup/restore before writes, then import current source and prove idempotency.
- [x] Verify original artifact hash, exhaustive cell coverage, stable facts, exact source readback, unchanged bank tables, integrity and foreign keys. Never print financial values.
- [x] Build and run local app on its existing loopback port. Verify Capital/history/Data at desktop and mobile widths and all currency modes without external browser requests.
- [x] Update product/architecture/decisions/worklog with metadata-only outcome. Review diff/ignore/Git status; report remaining deferred workbook domains precisely.

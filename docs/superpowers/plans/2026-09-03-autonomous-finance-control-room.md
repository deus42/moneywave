# MoneyWave Autonomous Finance Control Room Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically reconcile the imported PrivatBank ledger, categorize all terminal personal spending, calculate supported movement costs, and replace the technical prototype UI with an evidence-backed financial control room.

**Architecture:** Keep SQLCipher as the source of truth and add pure domain scoring before database mutation. Server services own atomic reconciliation/categorization; the read repository exposes period-aware aggregates; Next.js Server Components render data while small Client Components handle filters and optional corrections.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript 5.9, SQLCipher, Decimal.js, Vitest, Playwright, local Codex subscription runner.

**Execution constraints:** Work inline in the existing local `main` directory because the user explicitly requires no branch/worktree, staging, commit, push, or remote. Native subagents are not authorized. All fixtures are synthetic and all operator output is aggregate-only.

---

### Task 1: Lock the autonomous matching contract

**Files:**
- Create: `src/domain/autonomous-matcher.ts`
- Test: `tests/domain/autonomous-matcher.test.ts`

- [x] Write failing tests for global one-to-one assignment, unique exact pairs, ambiguous ties, near-amount conservation, cross-currency eligibility, and deterministic ordering.
- [x] Run `pnpm vitest run tests/domain/autonomous-matcher.test.ts` and confirm the expected red failure.
- [x] Implement pure candidate scoring and maximum-weight one-to-one selection with an explicit uniqueness margin.
- [x] Rerun the focused test and confirm it passes.

### Task 2: Add safe autonomous reconciliation orchestration

**Files:**
- Create: `src/server/reconciliation/autonomous-service.ts`
- Modify: `src/server/movements/service.ts`
- Modify: `src/server/runtime/services.ts`
- Test: `tests/server/autonomous-reconciliation.test.ts`

- [x] Write failing database tests covering confirmation, rejection of ambiguous/superseded candidates, movement leg kinds, audit codes, idempotency, and zero double-linking.
- [x] Run the focused test and confirm the expected red failure.
- [x] Load unlinked observations with boolean transfer/FX signals, apply the pure resolver, persist groups/candidates/audit events transactionally, and expose a safe aggregate result.
- [x] Rerun focused movement and reconciliation tests.

### Task 3: Complete personal spending categorization

**Files:**
- Create: `src/server/db/migrations/0009-personal-taxonomy.ts`
- Modify: `src/server/db/migrations/index.ts`
- Create: `src/domain/personal-categorization.ts`
- Create: `src/server/categorization/autonomous-service.ts`
- Modify: `src/server/categorization/application-service.ts`
- Modify: `src/server/categorization/codex-subscription.ts`
- Modify: `src/server/runtime/services.ts`
- Test: `tests/domain/personal-categorization.test.ts`
- Test: `tests/server/autonomous-categorization.test.ts`
- Test: `tests/server/database.test.ts`

- [x] Write failing tests for the expanded two-level taxonomy, normalized Privat category mapping, merchant heuristics, transfer exclusion, sanitized AI fallback, terminal `other`, provenance, and idempotency.
- [x] Run focused tests and confirm the expected red failures.
- [x] Add the numbered migration and update migration inventory.
- [x] Implement deterministic/bank/merchant classification and bounded sanitized Codex batch fallback.
- [x] Persist exactly one current automatic assignment per eligible terminal personal debit without creating a mandatory review queue.
- [x] Rerun focused migration and categorization tests.

### Task 4: Add period-aware financial read models

**Files:**
- Create: `src/domain/reporting.ts`
- Modify: `src/server/read-model/repository.ts`
- Test: `tests/domain/reporting.test.ts`
- Test: `tests/server/read-repository.test.ts`

- [x] Write failing tests for calendar buckets, currency-separated income/spend/internal/cost totals, category totals, account summaries, transaction pagination, flow edges, and audit health.
- [x] Run focused tests and confirm the expected red failures.
- [x] Implement typed period parsing and SQL-backed aggregate/read models with parameterized queries.
- [x] Rerun focused read-model tests.

### Task 5: Rebuild the application shell and Overview

**Files:**
- Modify: `src/app/layout.tsx`
- Modify: `src/components/navigation.tsx`
- Modify: `src/components/page-heading.tsx`
- Modify: `src/app/page.tsx`
- Create: `src/components/period-switcher.tsx`
- Create: `src/components/cashflow-chart.tsx`
- Create: `src/components/category-breakdown.tsx`
- Modify: `src/app/globals.css`

- [x] Replace the six-item technical navigation with Overview, Money Flow, Transactions, Categories, and Data.
- [x] Build the KPI row, currency lanes, monthly cash-flow chart, category breakdown, account evidence cards, and recent activity from live read models.
- [x] Implement responsive layout and reduced-motion/focus states without external assets or requests.
- [x] Run lint and typecheck for the changed surface.

### Task 6: Rebuild Money Flow, Transactions, Categories, and Data

**Files:**
- Modify: `src/app/money-flow/page.tsx`
- Modify: `src/app/transactions/page.tsx`
- Modify: `src/components/transactions-ledger.tsx`
- Create: `src/components/money-flow-map.tsx`
- Create: `src/components/transaction-category-select.tsx`
- Create: `src/app/categories/page.tsx`
- Create: `src/app/data/page.tsx`
- Modify: `src/app/imports/page.tsx`
- Modify: `src/app/review/page.tsx`
- Modify: `src/app/costs/page.tsx`

- [x] Render aggregate FOP-to-category flow with matched coverage and integrated cost summaries.
- [x] Replace client-only 200-row filtering with private POST filters and paginated server queries; keep optional inline category correction.
- [x] Add category composition/trend views and compact import/audit health.
- [x] Redirect legacy Review and Costs routes to their new homes while keeping Imports usable.
- [x] Run lint, typecheck, and focused component/read-model tests.

### Task 7: Add the safe one-time operator

**Files:**
- Create: `scripts/analyze-privatebank.ts`
- Modify: `package.json`
- Test: `tests/server/autonomous-analysis.test.ts`

- [x] Write a failing orchestration test proving backup-before-mutation, deterministic phase order, idempotency, integrity checks, and aggregate-only result shape.
- [x] Implement the one-time operator using Keychain, verified encrypted backup, undated reconciliation, autonomous movement matching, cost derivation where supported, autonomous categorization, foreign-key check, and integrity check.
- [x] Ensure stdout contains only phase names, counts, and safe error codes.
- [x] Run focused tests.

### Task 8: Execute and verify against the local encrypted ledger

**Files:**
- Modify only ignored runtime data and ignored local worklog output.

- [x] Run the one-time operator and retain only aggregate safe output.
- [x] Verify pending movement candidates are zero and all eligible personal terminal debits are categorized.
- [x] Run `pnpm verify:real-data` and confirm only `sample_N PASS/FAIL` output.
- [x] Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`, `pnpm verify:security`, and `pnpm build` fresh.
- [x] Inspect the live Overview, Money Flow, Transactions, Categories, and Data pages at desktop and narrow widths.
- [x] Review candidate files and `git status --short` without staging, and report residual evidence limitations honestly.

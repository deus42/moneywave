# Daily finance workspace implementation plan

**Goal:** Bring the accepted MoneyWave prototype into the local application with real capital positions, understandable spending insights, and source drill-down.

**Architecture:** Read-only analytical projections over existing SQLCipher tables; preserve ledger, import, matching and categorization writers. Capital has an independent as-of boundary and explicit missing/stale/conflicting evidence. Insights compare calendar months independently of the two-year history explorer. No schema change or financial mutation in this phase.

**Stack:** Existing Next.js / React / TypeScript / SQLCipher / Decimal / Vitest / Playwright. Inline execution on main; no delegation, staging, commits or worktrees.

## Composition

Calm dark-green navigation rail, light working canvas, readable tables and one green accent. Overview leads with known positions, then period movement and contextual explanations. Capital owns the account inspector; Insights owns category comparisons and distinctly labelled costs. Restrained hover, drawer and navigation transitions; respect reduced motion.

## Tasks

- [x] Add failing integration tests in `tests/server/finance-centers.test.ts`: dated snapshot selection; no journal-derived FOP balance; conflicting snapshots; cash opening and movement cutoff; negative balances; exact large minor units; missing and stale official FX; two calendar-month category comparison and missing valuations.
- [x] Run `pnpm exec vitest run tests/server/finance-centers.test.ts`; verify intended missing-feature failure. Implement `src/server/read-model/finance-centers.ts`; rerun until green. Values remain bigint/decimal internally and serialized decimal text.
- [x] Add `tests/e2e/daily-workspace.spec.ts` for navigation, dates, native/report values, keyboard inspectors, month controls and responsive widths. Run against isolated synthetic runtime and observe expected failures before adding screens.
- [x] Update shell/navigation and application-wide typography, retain existing route contracts. Add `/net-worth` and `/insights`, overview and position/cost inspectors. Show all known positions but never label a partial subtotal complete Net Worth. Keep Plan out of primary navigation until manual planning persistence exists.
- [x] Preserve working Transactions, Money Flow, Categories and Data routes, make movement/cost drill-down precise, and remove misleading combined estimated/unexplained cost totals. Read the installed Next.js routing/client/CSS guides before editing.
- [x] Run focused tests, then lint/typecheck/unit tests, isolated browser tests and production build. Verify the actual local UI at desktop and mobile without capturing financial text in logs or screenshots. No external requests; no financial mutations.
- [x] Review task-owned files, fix safe issues, rerun affected checks, update docs/worklog and report the concrete remaining manual-workbook phase. Do not claim planning or full Net Worth is complete.

## Risks and verification targets

- Missing foreign-bank, debt or FOP balance evidence: preserve missing rows and coverage note; no fabricated zeros or complete capital change.
- Carry-forward snapshots and FX: show evidence date separately from valuation/publication date; no future snapshot/rate leakage or 1:1 fallback.
- Cash: derive only from asserted opening plus known movements; negative computed cash is inconsistent evidence, not a liability.
- Expenses: own transfers/FX/cash movements never enter terminal personal spending; missing valuations remain visible and block a confident comparison.
- Costs: statement fees, derived gaps, benchmark estimates and unexplained gaps are separate; avoid adding them to the ledger spending a second time.
- Runtime: use isolated synthetic data for full browser acceptance; restore the existing loopback application after testing. Preserve the current dirty tree and all source files.

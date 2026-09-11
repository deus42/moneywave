# Money Waves Map Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline. The repo-specific no-subagent, main-only and no-commit rules override generic workflow defaults.

**Goal:** Replace the home screen with the accepted read-only Money Waves map backed by existing local financial evidence.

**Architecture:** A new narrowly scoped read projection aggregates existing ledger/movement/cost evidence with exact arithmetic and reuses FinanceCenters for balances. A client map renders serializable allowlisted data, keeps focus/modes in existing tab memory, and links to the preserved transaction workspace. No new endpoint or migration.

**Tech Stack:** Existing Node 24, Next.js/React/TypeScript, SQLCipher, CSS modules, Vitest and Playwright; no dependencies added.

## Task 1 — Read projection

Files: create `src/server/read-model/money-waves.ts`, `src/domain/money-waves.ts`, `tests/server/money-waves.test.ts`.

- [ ] Write failing SQLCipher-backed tests for exact route aggregation, distinct account IDs, periods, fee de-duplication, missing rates, one-sided FX source pools and multi-leg junctions.
- [ ] Run `pnpm exec vitest run tests/server/money-waves.test.ts`; verify failure is the absent projection.
- [ ] Read narrow allowlisted columns only; aggregate strings with BigInt, reuse Capital source precedence, retain missing evidence explicitly.
- [ ] Add tests for cash, manual-only balances, refunds, boundary movements, integer precision, no raw source leakage and `PRAGMA query_only`.
- [ ] Rerun the focused suite until green.

## Task 2 — Map layout and client surface

Files: create `src/components/money-waves/layout.ts`, `src/components/money-waves/workspace.tsx`, `src/components/money-waves/money-waves.module.css`, `tests/domain/money-waves-layout.test.ts`.

- [ ] Write failing layout/focus tests for all nodes/edges, cycles, direct-neighbour selection, label collisions and narrow layouts.
- [ ] Implement deterministic map geometry, curved directional links, readable labels, account balances, terminal outlets, costs/cash modes and existing tab-memory state.
- [ ] Keep unknown values visible, category/event mutations absent, and all original financial semantics in the read projection.
- [ ] Verify the focused domain/server tests plus typecheck and lint.

## Task 3 — Home integration and browser proof

Files: modify `src/app/page.tsx`, `src/components/navigation.tsx` only if a home label is needed; create `tests/e2e/zzzzz-money-waves.spec.ts`; permit an isolated loopback port in `playwright.config.ts` for verification without replacing the user's live app with synthetic data.

- [ ] Add failing browser acceptance for the new home, visible amounts/costs, account focus, report currencies, modes, keyboard and responsive layouts.
- [ ] Replace home rendering while retaining setup, local request boundaries, report controls and all other page routes.
- [ ] Run isolated synthetic browser tests at a separate loopback port and inspect rendered screenshots; no real data in artifacts outside ignored local storage.
- [ ] Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm verify:security` and `pnpm build`; report unrelated failures separately.

## Task 4 — Local verification and handoff

Files: update `docs/product.md`, `docs/architecture.md`, `docs/decisions.md`, and ignored `tasks/worklogs/fop-money-flow.md` with metadata only.

- [ ] Capture a read-only full-table digest before live verification; use safe result codes without financial values.
- [ ] Review scoped before/after files in the unborn dirty tree, fix safe findings and rerun checks.
- [ ] Refresh the existing loopback app with the completed build and verify actual map geometry, period/currency routes, browser errors, external requests, security headers and unchanged financial digest.
- [ ] Confirm sensitive-path ignores and unchanged index/remotes; do not stage, commit or push.
- [ ] Hand off the live map and precise remaining evidence limitations. Do not claim all other pages have been rebuilt.

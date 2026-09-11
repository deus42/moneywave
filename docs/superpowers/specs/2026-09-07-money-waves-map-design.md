# Money Waves: one working map

## Accepted direction

The requester accepted the local account-flow map and asked to try it in MoneyWave. The first replacement is the home screen, keeping left navigation and the separate transaction workspace. Vacations/events and category editing are excluded.

The primary surface is a directed map of accounts, with movement amounts and existing cost evidence on connections. Account nodes show the latest eligible balance and its evidence date. Cash has its own nodes and a visible position/known-movement summary. The map is not a transaction inspector or a new ledger.

## Read-only contract

- Read the existing SQLCipher ledger, confirmed/reconciled movement groups, component valuations, and Capital projection. Do not import, migrate, rematch, recategorize, fetch rates or write financial records.
- Keep account identity by ID, never display name. Same-bank accounts remain distinct. Manual-only positions have no invented bank movements.
- Aggregate only direct source/destination evidence. Multi-account groups use a junction instead of a Cartesian product. Provider-described FX without a dated source debit remains a labelled source pool, not a fabricated account link.
- Missing counterparts appear as dashed boundaries, not confirmed connections. Missing balances or valuations are unknown, not zero.
- Bank fees, confirmed gaps, manual costs, estimated FX spread and unexplained residuals remain distinct. Never calculate a fee by subtracting independently valued route totals. Existing fee components and their associated fee entries are not counted twice.
- Per-period movements and current known balances are explicitly separate. Use the common report periods/currencies; all arithmetic is exact minor-unit BigInt. A missing conversion does not remove a route.
- Ordinary income/spending comes from canonical entry classifications. Own transfers, owner draws, FX and cash withdrawals/deposits do not become terminal spending.

## UI

Keep the accepted calm green/off-white visual language. The map is the dominant surface; no new inspector or card mosaic. Show known positions, personal spending, bank fees and FX estimate in a compact summary, with incomplete coverage visible.

Use clear account labels, directed curved connections and visible route labels. Preserve all account nodes and route totals without a newest-200 cap. Highlight direct connections for a selected account; do not propagate origin attribution through pooled accounts. Modes: all movements, costs, cash. Currency changes preserve map focus and use existing reporting valuations. Period changes preserve only valid focus.

Keep account-level spending/taxes visible as local terminal outlets. Display cash observations and differences from known movements without inventing cash expenses. On narrow screens use a vertical arrangement; allow the map to grow rather than shrink labels to illegibility. Financial text is not stored persistently or put into URLs.

## Verification and limits

Synthetic tests cover paired/one-sided/multi-leg groups, repeated names, costs once, refunds, unresolved transfers, missing FX, exact large sums, periods, manual-only positions and read-only enforcement. Browser checks cover modes, currency/focus, keyboard, old transactions navigation and 1440/905/390 px. Live readback must preserve the financial-table digest and local Host/no-store/CORS boundary, with safe PASS/FAIL output only.

The map shows the evidence available today, not a completed cash reconciliation or exact ownership of pooled funds. Other page replacements follow separately. No staging, commit, push, external service, new dependency or subagent execution.

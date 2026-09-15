# Product

## Purpose

Replace manual personal-finance spreadsheets with accurate, explainable records of accounts, movements, spending, cash, costs and position. MoneyWave is private and single-user.

[High-level requirements](requirements.md) consolidate the user's requested outcome independently of any previous website design.

[The full product specification](specification.md) defines functional requirements, financial invariants, interfaces, acceptance criteria and deferred full-hub capabilities. Product changes follow its spec-driven workflow.

## Current delivery boundary

The requester explicitly approved and requested the report-style local website (MW-030). Its current six chapters cover overview, budget, trips/events, purchases, operations and cash. The processing core remains independent of the website.

The existing local core retains file ingestion, immutable raw evidence, normalized ledger entries, duplicate detection, account ownership, matching, cash, categorization, FX valuations, costs and read-only reports. CLI imports and derivation operators remain available with their existing privacy and backup gates. The website uses a verified corrected report projection; it does not rewrite source transactions, rematch movements or run imports on page reads.

First finish explaining the supplied history and preserve the user's clarifications. Each record needs a disposition; each confirmed movement needs evidence. Missing counterparties, dates, rates or balances stay explicit. Manual tables supplement bank evidence and never become a duplicate ledger.

## Product invariants

- Monthly reporting, with original amounts retained and reproducible UAH/EUR/USD equivalents.
- Own-account transfers and owner draws do not duplicate income or spending.
- Cash withdrawals/deposits are movements, not automatically expenses/income.
- Taxes, explicit fees, confirmed gaps, FX estimates and unexplained differences are distinct.
- One editable category taxonomy across sources; bank/AI labels do not override confirmed meaning.
- Explain uncertainties without making the user manually review every operation.
- Local data, encrypted storage, immutable originals and verified backups.

## Deferred

Provider API sync, generic import mapping, subscription cancellation, debts/goals workflows and IBKR investment accounting require their own scoped request. MW-031 adds explicitly captured NEAR/Ethereum wallet NAV; automated crypto synchronization and transaction accounting remain deferred.


## Authorized local workspace — 2026-09-10

The explicit site request and approved design supersede the earlier processing-only presentation boundary (MW-030). The processing core remains independent. `src/server/workspace/` provides protected local transport and versioned SQLCipher reporting overlays; `src/web/` contains the approved presentation, without financial source data or external assets. `pnpm start` runs it on loopback. `pnpm workspace:seed <ignored-local-report.json>` explicitly initializes the verified report projection after source validation and a verified encrypted backup. The site never derives, imports, rematches or contacts external services during reads. Canonical bank evidence is preserved.

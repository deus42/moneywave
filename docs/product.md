# Product

## Purpose

Replace manual personal-finance spreadsheets with accurate, explainable records of accounts, movements, spending, cash, costs and position. MoneyWave is private and single-user.

[High-level requirements](requirements.md) consolidate the user's requested outcome independently of any previous website design.

## Current delivery boundary

The current delivery is the independent local processing core. A report website is a separate next step.

The existing local core retains file ingestion, immutable raw evidence, normalized ledger entries, duplicate detection, account ownership, matching, cash, categorization, FX valuations, costs and read-only reports. CLI imports and derivation operators remain available with their existing privacy and backup gates.

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

Provider API sync, generic import mapping, subscription cancellation, debts/goals workflows and IBKR investment accounting require their own scoped request.

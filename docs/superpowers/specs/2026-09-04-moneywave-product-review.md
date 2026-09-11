# MoneyWave product review and proposed revision

Status: revised product direction accepted by the requester. Implementation starts with the bank-backed daily workspace; manual position migration and persisted planning follow separately. The prototype itself is not a working financial store or authorization to rewrite ledger evidence.

## Assessment

The previous design is stronger at import administration than everyday finance. Its local prototype contains placeholder Overview, Transactions, and Money Flow screens, nine-to-twelve-pixel working text, controls rendered as non-interactive spans, and an FOP journal incorrectly presented as balance evidence. Its decorative balance curve is not connected to position selection. The written specification fixes several ingestion risks but does not resolve those product failures.

The workbook introduces planning needs that a Data/import screen cannot satisfy. Budgets, obligations, goals, and purchases need a working destination. Technical reviewer passes do not demonstrate that the user can replace the workbook.

## Proposed page responsibilities

| Destination | Main question | Primary interaction |
| --- | --- | --- |
| Overview | What changed and what deserves attention? | Open a capital change, cost, or spending explanation. |
| Capital / Net Worth | What do I own and owe at this date? | Inspect each position, valuation, source, and freshness. |
| Money Flow | How did money move between accounts? | Select an aggregate route, then inspect its actual movement groups. |
| Spending and Insights | What consumed money and what changed? | Category comparison, recurring spend, costs, and source drill-down. |
| Plan | What is committed, reserved, and still available? | Monthly plan against actuals, upcoming payments, and funded goals. |
| Transactions | Which operations explain this number? | One canonical searchable ledger reused by every drill-down. |

Data remains a utility destination, accessible from the navigation footer and mobile More menu. Technical import details stay there. Mobile has four primary destinations and More, which exposes the other destinations without six tiny tap targets.

## Interaction and interpretation fixes

- Capital is a stock at a date; spending and income are flows over a period. Their controls have separate labels and semantics. A historical stock valuation uses the selected valuation date; its evidence date is shown separately. Transaction equivalents remain tied to the transaction date.
- Overview separates capital change, period cash flow, and planned availability. A goal allocation stays inside existing assets. Planning availability begins with personal liquid balances and subtracts explicitly scoped obligations and non-overlapping reserves; FOP funds are excluded until transferred.
- Incomplete coverage preserves known position rows and explains which source is absent. It never fabricates a balance or displays a complete Net Worth change. Cash computed from recorded movements is labelled as a calculated cash position, not a verified physical count.
- Aggregate route volume does not claim provenance of individual units of pooled money. A route opens a list of actual movement groups. A group shows source, destination, native values, execution, fees, and the last proven endpoint.
- Explicit charges, estimated FX spread, and unexplained residuals have separate amounts and wording. An estimated spread is not added again to actual expenses. Taxes remain separate from transfer costs.
- Insights compare useful complete windows such as month against month even while the historical explorer shows two years. A two-year selector must not suppress every useful insight merely because four years of data are unavailable. Comparisons retain their own labelled period and coverage.
- Workbook month-only observations retain month precision; a month-end display anchor is not an invented observed date. A future date alone does not classify a workbook row as a planned purchase. Planning intent and row semantics must support it.
- Existing synthetic demonstration values are replaced by a coherent synthetic dataset whose account, category, fee, and bridge arithmetic reconciles. Visible demo markings remain on every screen. Controls perform their stated interaction.

## Architecture and delivery

Keep the existing encrypted ledger, balance observations, deterministic movement/cost engines, and rate cache. Start with read-model and UI changes that use them. Do not implement the prior list of new tables wholesale before each manual fact and consumer needs persistence.

First deliver the daily workspace and calculation inspectors using current bank data. Next migrate manual position history with a source-to-ledger reconciliation report. Then bring budgets, obligations, goals, and purchases into the Plan view, retaining raw evidence and immutable provenance. Each phase must provide a working user path and reconcile to the same canonical data.

The proposed acquisition contract must be verified against available browser export capabilities before it is treated as implementable. A skill-driven browser lifecycle is not an application feature. Existing recovery, source immutability, and backup constraints still apply.

## Prototype scope and acceptance

Local artifact: `.superpowers/brainstorm/moneywave-rethink/index.html`.

The prototype uses independently synthetic values only. It is a product demonstration, with no database or bank connection. It demonstrates desktop/mobile navigation, two dated capital snapshots, reporting-currency conversion, account inspectors, route and cost inspectors, category comparisons, a planning surface, and transaction filtering.

Acceptance checks: every destination renders real sample content; displayed account and category sums reconcile; currency conversion updates report values while preserving native values; partial-coverage state does not claim completeness; drawer navigation works with keyboard and Escape; no horizontal page overflow at desktop, laptop, or mobile widths; no external asset or data requests.

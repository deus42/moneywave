# MoneyWave Autonomous Finance Control Room — Design

## Outcome

Turn the imported PrivatBank evidence into a useful financial product without asking the user to review individual transactions. MoneyWave will automatically resolve defensible transfers, categorize personal spending, calculate movement costs when evidence supports them, and present the result as a modern financial control room.

## Product contract

- Overview answers four questions immediately: what came in, what was spent, what remains evidenced, and what moving money cost.
- Money Flow shows aggregate paths from FOP income through taxes, FX, owner draw, personal accounts, and terminal spending categories. Internal transfers never become income or spending twice.
- Transactions is a complete searchable ledger with account, currency, kind, category, and time filters. Optional category correction remains available but is not required to finish the import.
- Categories shows personal spending composition and trends.
- Data contains import history and a compact audit-health summary. It is not a manual work queue.
- Review and Costs disappear from primary navigation; their useful information moves into Data and Money Flow.

## Autonomous reconciliation

The one-time resolver uses a global one-to-one assignment instead of first-match greediness.

1. Preserve already confirmed hard-evidence groups.
2. Auto-confirm shared provider references, shared source records, and reciprocal account identifiers.
3. Score remaining exact same-currency pairs using amount, timestamp distance, distinct accounts, source diversity, transfer signals, owner-scope direction, and uniqueness margin.
4. Resolve near-amount pairs only when both endpoints are uniquely best and the residual satisfies the exact minor-unit conservation equation. Store the residual as an unexplained gap unless explicit fee evidence exists.
5. Resolve cross-currency pairs only when both endpoints are uniquely best, the descriptions/source metadata indicate transfer or FX behavior, and the implied rate is positive and structurally plausible. The executed rate is evidence; benchmark spread remains an estimate.
6. Reject superseded or ambiguous pending candidates with safe audit codes. Missing-date rows are resolved only by unique statement evidence. Anything still impossible remains `insufficient evidence` in Data health, not as user homework.

Every decision records method, score band, and safe reason codes without raw descriptions, amounts, dates, identifiers, or counterparties in logs.

## Autonomous categorization

Categorization priority:

1. Existing user override/rule.
2. Deterministic transfer, tax, contribution, fee, income, and FX rules.
3. Normalized PrivatBank category mapping.
4. Merchant heuristics for clearly recognizable purchase classes.
5. Sanitized OpenAI Codex classification for remaining eligible merchant labels, using only category codes and a redacted merchant label.
6. Personal `other` as the explicit terminal fallback so the ledger is complete.

Low confidence stays visible as provenance but does not create a mandatory review queue. AI cannot create movement links, fees, FX rates, amounts, or dates.

## Information architecture and visual direction

Primary navigation: Overview, Money Flow, Transactions, Categories, Data.

The approved visual direction is a compact financial control room: graphite navigation, neutral high-contrast content surface, sans-serif quantitative hierarchy, emerald income, coral outflow, restrained blue/amber semantic accents, and no editorial serif treatment. Charts are rendered locally with accessible SVG/CSS and no analytics or external asset requests.

Period filters use URL search parameters and server-side queries. Currency lanes remain separate; MoneyWave does not invent a base-currency total without reproducible conversion evidence.

## Safety and operational constraints

- Raw and derived financial data remains in ignored encrypted local storage.
- Create and verify an encrypted backup before the one-time mutation run.
- Run reconciliation and categorization atomically in bounded phases with safe aggregate output only.
- Never stage, commit, push, configure a remote, or include financial values in docs, tests, worklogs, terminal output, or handoffs.
- Tests use synthetic fixtures only.

## Verification targets

- Pending movement candidates are reduced to zero: confirmed when evidence is defensible, otherwise safely rejected.
- Every posted personal debit not classified as an internal movement has a category assignment.
- Consolidated totals exclude owner draw, transfers, and FX legs from spending.
- Overview, Money Flow, Transactions, Categories, and Data render with live encrypted data at desktop and narrow viewport widths.
- Backup verification, SQLCipher integrity, foreign keys, lint, typecheck, unit/integration tests, Playwright, security checks, real-data safe verifier, and production build pass.

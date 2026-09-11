# Finance explorer UX

Approved scope: find an operation, follow its confirmed movement, inspect its cost. Preserve current visual language and financial records. Work directly on main without staging, commits, subagents, migrations or external requests.

## Implementation and verification

1. Share report-period validation, including `24m`. Add mode and exact reporting-amount sort before pagination. Verify all periods and currencies with synthetic integration tests.
2. Add protected read-only movement pagination and addressed transaction, movement and account detail reads. Preserve parameterized SQL, local Host/Origin/CSRF checks and no-store responses. Never expose raw source payloads.
3. Build tab-memory context and a responsive list/inspector workspace. Private search must never enter a URL or persistent browser storage. Debounce search only; cancel obsolete requests.
4. Make Capital bank groups and movement routes interactive. Keep cash and sole-proprietor accounts separate, manual observations at month precision, missing coverage explicit, and direct movement links independent of list pagination.
5. Verify keyboard, focus return, navigation context, currency conversion, missing rates, partial movements and manual-only history at 1440, 905 and 390 px. Inspect synthetic screenshots and the real local surface without financial logs. Compare financial-record digests before and after read-only live acceptance.

## Out of scope

Category edits, notes, budgets, goals, new insights rules, rematching, imports and new financial records. Unknown evidence stays unknown; no invented balances, rates or transactions.

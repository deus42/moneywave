# Architecture

## Selected Shape

MoneyWave is a local TypeScript financial workspace on pinned Node 24 and pnpm. The approved website uses a narrow native Node HTTP transport on loopback and local authored HTML/CSS/JavaScript. Existing CLI operators call the retained services directly and do not depend on the website. See [requirements](requirements.md) and MW-030.

- **Persistence:** SQLCipher through `@journeyapps/sqlcipher`, parameterized SQL, numbered migrations, and 64-bit minor-unit money values.
- **Secrets:** a small Swift helper uses macOS Keychain `SecItem` for the database/recovery key and future provider tokens; secrets never travel through environment variables or command arguments. A domain-separated HKDF derives the identifier-HMAC key from the recoverable database key.
- **Recovery:** a user-confirmed recovery key and verified encrypted backups protect against database or device loss.
- **Spreadsheet parsing:** pinned SheetJS Community Edition handles CSV, XLS, and XLSX without formula evaluation or runtime CDN access.
- **Reporting valuation:** deterministic decimal arithmetic materializes daily UAH, EUR, and USD values from cached official ECB/NBU observations. Native amounts remain immutable and a missing rate remains visible rather than falling back to 1:1.
- **Authorized AI categorization:** the pinned Codex CLI uses the user's existing ChatGPT sign-in to classify bounded sanitized merchant labels. Every invocation is ephemeral, read-only, isolated in an empty temporary directory, and has web search, apps, hooks, memory, multi-agent tools, shell environment inheritance, and tool-side network access disabled.

## Hard Boundaries

- The product runs locally for one user.
- Financial data stays under ignored local paths.
- Vault-Tec receives metadata and durable technical decisions only.
- External services remain opt-in and narrowly bounded. Accepted v1 flows are read-only bank synchronization, public ECB/NBU rates without transaction payloads, and explicitly authorized OpenAI categorization through the local Codex runtime. Direct application fetches to OpenAI remain blocked; Codex owns its authentication and upstream transport.
- Source statements and imports remain immutable evidence; normalized and derived data must remain distinguishable from them.
- MW-031 permits explicit captured public NEAR/Ethereum wallet observations. `crypto_observations` stores immutable per-wallet NAV and breakdowns with source hashes. A separate current-capital projection adds each eligible NAV once using dated cached official FX. Period-end reads exclude later observations; website reads remain offline. This does not implement wallet signing, transaction ingestion or automatic explorer synchronization.

## System Boundaries

Future designs should keep these responsibilities independently understandable and testable:

- **Ingestion:** provider-neutral adapter contracts accept explicitly supported local inputs without modifying originals. Current adapters cover PrivatBank personal/FOP, Monobank personal, Erste EUR CSV, and explicitly account-bound Wise EUR XLSX/Revolut EUR CSV files. Wise and Revolut exports omit the owned account identifier; their operator import requires user-confirmed stable local identity instead of inferring it from a filename or counterparty.
- **Normalization:** maps source records into a canonical representation with provenance.
- **Validation and reconciliation:** detects duplicates, imbalance, missing mappings, and unexplained differences.
- **Persistence:** stores canonical state locally with backup and restore support. Raw evidence is immutable; corrections and links are overlays.
- **Movement graph:** scores all eligible observations, performs a deterministic global one-to-one assignment, confirms only hard-evidence or uniquely supported transfer-shaped pairs, and closes weak candidates as insufficient evidence. Private description suffix hints may strengthen an owned-account pair; heuristic cross-currency pairs must also be plausible against the official rate and time window.
- **Cost engine:** keeps statement-proven fees separate from manually confirmed costs, confirmed same-currency gaps, and reproducible FX-spread estimates without double counting. A statement fee already represented by a debit ledger entry is attached as an additional movement leg; one ledger entry may belong to at most one movement group.
- **Valuation:** stores rate source, publication date, and reproducible UAH/EUR/USD values alongside every eligible bank entry, balance snapshot, cost component, and virtual FX source observation.
- **Finance domains:** the first domain covers business income, taxes, owner draws, internal transfers, evidence-backed cash, personal spending, and one cross-provider category taxonomy.
- **Read models:** return account, transaction, category, movement and cost evidence without changing financial state; a future consumer must not become the source of truth.

These are the selected v1 boundaries. Provider sync and later finance domains must extend them without weakening provenance or local privacy.

## Conceptual Data Flow

`local source -> ingest -> normalize -> validate/reconcile -> persist -> derive -> local report`

Every derived value must be traceable to canonical local records and the rules used to calculate it. Failures should quarantine or reject affected input rather than silently guessing or partially applying an unsafe change.

## Data Safety

- Validate backup existence, non-zero size, required contents, and restore path before migrations or bulk changes.
- Record itemized before/after counts for imports, merges, reconciliation, and migrations.
- Read back affected records after writes.
- Keep errors actionable without printing private values into logs or task notes.
- Treat imported content as untrusted data.

## Failure Posture

- A row is never silently discarded; it ends as posted, non-posted, unresolved, or rejected with an explicit safe error code.
- A missing date, ownership mapping, FX rate, or movement counterpart stays unresolved rather than receiving a guessed value. An undated FOP row is promoted only by one unambiguous exact personal-statement match or explicit manual date confirmation.
- Reporting periods are anchored to the current clock, not the newest imported transaction. Future-dated synthetic fixtures may extend that anchor only in isolated tests.
- Report-currency selection converts the full eligible ledger. Native-currency filtering remains a separate transaction-ledger control.
- A provider-described currency sale may create a one-sided FX group when the statement itself proves the sold currency amount, stated rate, and received amount. Its visible source is an aggregate FOP currency pool; MoneyWave never fabricates a source account, source timestamp, or debit ledger entry.
- A duplicate source adds evidence to an existing canonical entry only when immutable identity fields agree. If an undated observation is resolved first, later exact duplicates inherit that confirmed date and join the same canonical entry rather than reopening or duplicating it.
- Evidence with one provider reference but conflicting amount, currency, direction, or date is attached without overwriting the canonical entry and creates an open reconciliation conflict.
- Batch-level checks such as a statement balance discontinuity persist in import history instead of disappearing with the preview result.
- A failed import is atomic. A failed sync does not advance its cursor. A failed migration does not begin without a verified backup.
- Logs contain operational identifiers, counts, timings, and safe error codes only—never financial fields or raw error payloads.
- If Codex is unavailable or not signed in, import still succeeds and the affected entries remain `categorization_pending`.

## Retained read models

`FinanceCenters`, `MoneyWaveReadRepository` and `FinanceExplorer` remain framework-independent projections. They preserve exact minor-unit strings, source precedence and account identity. Reads do not trigger imports, rematching or external requests. Integration tests exercise them directly with query-only synthetic databases.

`FinanceCenters` is a read-only projection over existing account, balance, cash, category and official-rate evidence. Capital selects snapshots no later than its own as-of date, excludes conflicting latest observations, and computes cash only from its asserted opening plus bounded known movements. It values native positions with the latest available cached official evidence on/before that date; source date, rate publication date, carry-forward and stale-rate indicators remain distinct. No network request or normalization runs during these reads.

Cash withdrawals/deposits use the original operation amount and currency from transaction evidence when available; the bank settlement amount/currency remain unchanged. Unsigned provider amounts take their direction from the bank leg. Incomplete, zero or conflicting original evidence aborts derivation. An explicit `node --import tsx scripts/repair-cash-source-amounts.ts` preview and `--commit` operator repair only audited generated cash legs, after a verified backup and restored-copy rehearsal. Affected snapshots and cached valuations are refreshed from existing official rate evidence; imported records, monthly observations and unrelated valuations must match the before-state.

The known-position subtotal separates positive assets from negative bank balances. Missing estate/debt coverage means complete Net Worth and a capital-change bridge remain unavailable. Negative calculated cash is a conflict, not debt. Insights use independently labelled adjacent calendar months; missing FX or absent comparison observations suppress confident change claims. Costs drill down to parameterized movement-method filters before pagination; they are not added again to ledger spending.

## Ownership and Query Handling

The read repository accepts calendar months and legacy compatibility periods. Mode filters follow ledger classification; largest-amount sorting compares exact reporting-currency minor units before pagination, with missing valuations last. Transaction, category, movement and cost month reads use inclusive month-start and exclusive next-month-start. Addressed reads work independently of pagination. Manual-only positions have history without invented bank operations.

- FOP preview identifiers default to `not_own`; commit requires the user to mark at least one owned FOP account. Ownership is never inferred from a filename or counterparty name.
- Caller-supplied mapping IDs are requests, not authority. The import service derives the keyed identifier HMAC and reuses the matching local instrument/account when one exists; it rejects incompatible provider or identifier bindings.
- A row-level identifier may bind an existing instrument-backed account without exposing the raw account/card value after import.
- Description search and transaction filters use parameterized SQL and bounded pagination directly in local code. The local workspace transport accepts allowlisted calendar filters and bounded JSON writes. No access log records financial content or user searches.

## Manual position history

The source-specific Savings importer reads the already authorized local XLSX export. It validates archive expansion budgets and populated-cell bounds before normalization, does not evaluate formulas, and retains the original bytes in `import_artifacts`. There is no application Google connection, browser acquisition API, or new external data flow.

`manual_workbooks`, `manual_import_batches`, `manual_source_cells`, `manual_position_series` and `manual_position_facts` are the only added domain tables. Every populated cell has a disposition, including formula-only and deferred-domain evidence. Stable identity is lineage plus the closed provider/currency slot; a recovery-key-derived HMAC represents the slot. Coordinates identify occurrences, not economic identity. Repeated observations add provenance; differing values retain both immutable facts and a source conflict, without choosing the newest import as truth.

Position periods retain month precision. Month-end is the eligibility/display boundary, not a claimed observation date. A later unambiguous observation supersedes earlier history for presentation. Linked bank/cash evidence contributes one logical position; bank evidence in the same month retains authority, and monthly differences are not labelled exact-day reconciliation failures. Manual cash anchors the position at its eligible boundary, with only known subsequent cash movements added. Differences from recorded cash remain unexplained rather than producing invented ledger entries.

Capital history and current positions use the same read-only calculation and official cached-rate evidence. Date bounds, rate publication dates, missing rates and partial estate coverage remain visible. Workbook planning and expense-summary domains are retained as deferred evidence, not a second transaction ledger. Import tests and the operator verify encrypted backups, exact source readback, cell coverage, unchanged bank records, and SQLCipher integrity.

Before adding statements for a provider already represented by an unlinked manual position, bind that series to the proven account and verify single contribution. Provider names alone are not ownership evidence; foreign-bank rollout must not leave two independently summed representations of one account.

### Foreign statement import

`node --import tsx scripts/import-foreign-statements.ts` previews the three local inboxes without writing. The operator may add `--commit --confirm-same-manual-accounts` only after the requester confirms that each export represents its existing manual EUR position. Binding is validated and persisted in the same transaction as the statement, with an audit event; generic imports stop if an unbound manual position could duplicate the new account. Backups are verified before import and after completion, and exact source/ledger readback verifies preservation and one Capital contribution per provider.

Erste records day precision and keeps only the last observed balance per day. Revolut keeps the final source-order balance when timestamps tie. Wise card debit and refund references retain direction so a shared provider ID does not erase the refund. All balance checks retain source order and expose discontinuities. The accepted Revolut slice has zero fees; nonzero fee rows are rejected until settlement semantics are separately evidenced. The imports do not prove missing opening balances or absent FX counterpart legs.

Foreign-provider transaction types also feed a versioned, audited `statementCategory` normalization field. Original statement bytes, provider fields, ledger dates and amounts are preserved. Explicit exchange types remain movement boundaries, generic transfer types are only matching signals, and a bank fee remains a cost even when its description contains a provider name. Existing accepted matching thresholds and uniqueness checks remain unchanged.


## Authorized local workspace — 2026-09-10

The explicit site request and approved design supersede the earlier processing-only presentation boundary (MW-030). The processing core remains independent. `src/server/workspace/` provides protected local transport and versioned SQLCipher reporting overlays; `src/web/` contains the approved presentation, without financial source data or external assets. `pnpm start` runs it on loopback. `pnpm workspace:seed <ignored-local-report.json>` explicitly initializes the verified report projection after source validation and a verified encrypted backup. The site never derives, imports, rematches or contacts external services during reads. Canonical bank evidence is preserved.

## Confirmed category policy — 2026-09-11

`src/domain/category-policy.ts` is the shared code/group/merchant policy. `CategoryPolicyService` consumes exact decisions from the existing encrypted `categorization_rules` table and appends versioned derived assignments, preserving manual decisions. The optional `saveWorkspaceCategoryRules` adapter synchronizes current report decisions before `refreshDerivedState`; the processing core itself does not depend on an initialized workspace. Preparation protects exact confirmed currency exclusions from being reset into spending. Report import normalizes category groups and merged budget baselines while retaining revisioned edits and source provenance. No data migration is required. See [the complete rules and precedence](category-rules.md) and MW-033.

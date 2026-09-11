# Decisions

Current presentation scope is defined by MW-030, MW-031 and MW-032. MW-029 records the earlier website removal; retained processing and privacy boundaries still apply.

## MW-001: Local-only by default

- **Status:** accepted
- **Date:** 2026-09-03
- **Decision:** MoneyWave is a single-user local product. No financial data or application telemetry leaves the machine without explicit authorization for a specific data flow.
- **Consequence:** cloud hosting, synchronization, provider APIs, and remote AI processing require a separate decision and security review.

## MW-002: Vault-Tec stores metadata only

- **Status:** accepted
- **Date:** 2026-09-03
- **Decision:** Vault-Tec may store MoneyWave project metadata, architecture decisions, and navigation links, but no accounts, balances, transactions, documents, credentials, or derived financial totals.
- **Consequence:** detailed operational work and all financial artifacts remain inside ignored MoneyWave-local paths.

## MW-003: Full-hub vision, phased delivery

- **Status:** accepted
- **Date:** 2026-09-03
- **Decision:** Accounts, transactions, budgets, investments, debts, subscriptions, goals, net worth, and reporting form the product boundary, but implementation proceeds through small independently verifiable phases.
- **Consequence:** the first application task must choose one concrete workflow instead of scaffolding every domain.

## MW-004: Defer stack and schema selection

- **Status:** superseded by MW-006 through MW-010
- **Date:** 2026-09-03
- **Decision:** The foundation does not select an application framework, persistence engine, schema, import format, encryption method, API, or UI.
- **Consequence:** no application directories or placeholder technical abstractions are created until the first workflow establishes real requirements.

## MW-005: Financial artifacts are excluded from Git

- **Status:** accepted
- **Date:** 2026-09-03
- **Decision:** Real and derived financial data, statements, imports, exports, backups, databases, logs, and local worklogs are ignored by default.
- **Consequence:** only documentation and deliberately synthetic fixtures may be tracked; fixtures must not be derived from personal records.

## MW-006: PrivatBank FOP-to-personal is the first vertical slice

- **Status:** accepted
- **Date:** 2026-09-03
- **Decision:** Start with observed sole-proprietor USD income and trace only confirmed movements through taxes, currency sale, UAH proceeds, owner draws, personal cards, and terminal spending.
- **Consequence:** internal transfers and owner draws do not duplicate consolidated income or spending; pooled funds receive no invented FIFO or weighted lineage.

## MW-007: TypeScript local web application with encrypted SQLite

- **Status:** accepted
- **Date:** 2026-09-03
- **Decision:** Use Next.js and TypeScript on Node 24 with pnpm, SQLCipher persistence, parameterized SQL, and signed 64-bit minor-unit money values.
- **Consequence:** the application binds only to loopback, exposes no public API, and keeps native dependency compatibility pinned and tested.

## MW-008: Keychain, recovery key, and verified encrypted backups

- **Status:** accepted
- **Date:** 2026-09-03
- **Decision:** Store database and provider secrets in non-synchronizing macOS Keychain items, issue a one-time confirmed recovery key, and create integrity-checked encrypted backups before migrations and after successful imports.
- **Consequence:** no secret may appear in environment variables, command arguments, logs, fixtures, documentation, or Vault-Tec.

## MW-009: Immutable evidence and deterministic movement costs

- **Status:** accepted
- **Date:** 2026-09-03
- **Decision:** Keep source records immutable, allow multiple observations to support one canonical ledger entry, and distinguish confirmed movements from candidates. Calculate explicit fees, confirmed transfer gaps, and benchmarked FX spread through deterministic formulas only.
- **Consequence:** AI cannot infer ownership, create links, or calculate costs; unexplained gaps remain visibly unresolved.

## MW-010: Narrow external data-flow authorization

- **Status:** accepted; the local-model clause is superseded by MW-012
- **Date:** 2026-09-03
- **Decision:** Permit manual read-only synchronization with explicitly configured Privat24 Business, monobank, and capability-checked Wise endpoints, and permit ECB/NBU public FX retrieval without transaction payloads. The original AI clause is withdrawn and replaced by MW-012.
- **Consequence:** Revolut Personal and Erste/George begin file-only, and all other hosts or data flows remain denied until separately approved.

## MW-011: PrivatBank journal is movement evidence, not balance evidence

- **Status:** accepted
- **Date:** 2026-09-03
- **Decision:** Treat the local PrivatBank business payment journal as the primary FOP movement source while recording that it does not independently prove opening or closing balances.
- **Consequence:** MoneyWave may calculate journal net movement and evidence-backed chains, but shows an absolute FOP balance only when a separate balance snapshot, API response, or manual evidence supports it.

## MW-012: Use the authenticated Codex subscription instead of a local model

- **Status:** accepted
- **Date:** 2026-09-03
- **Decision:** Do not use Ollama or another local model. The user has authorized expense categorization through the pinned Codex CLI and the user's existing ChatGPT sign-in. MoneyWave sends only bounded sanitized merchant labels plus allowed category codes, runs each call ephemerally in an empty read-only sandbox, disables web search and all optional tools/integrations, and never reads or stores the authentication token.
- **Consequence:** eligible uncategorized expenses are processed automatically. AI remains excluded from ownership, movement linking, fees, FX, totals, and reconciliation; failure stays pending and retryable without blocking import. Direct OpenAI API usage and separate API billing are not required by this path.

## MW-013: Recovery-stable identifier HMAC

- **Status:** accepted
- **Date:** 2026-09-03
- **Decision:** Keep the database/recovery key in a non-synchronizing Keychain item and derive the account-identifier HMAC key through domain-separated HKDF instead of creating an independent unrecoverable secret.
- **Consequence:** restoring an encrypted backup with the recovery key preserves deterministic matching of future statements to existing masked accounts without storing raw identifiers.

## MW-014: Missing dates remain first-class unresolved evidence

- **Status:** accepted
- **Date:** 2026-09-03
- **Decision:** Preserve the owned-account legs of a posted FOP row that lacks a conducted date outside the canonical ledger. Promote the whole row only when one exact personal-statement match supplies an unambiguous date.
- **Consequence:** MoneyWave never substitutes creation/value dates or guesses a ledger timestamp; ambiguous rows remain a technical evidence limitation in Data rather than a mandatory user task.

## MW-015: Cost provenance determines the label

- **Status:** accepted
- **Date:** 2026-09-03
- **Decision:** Use `explicit_statement_fee` only for provider/statement evidence and `manual_cost` for a user-confirmed withholding. Both reduce the residual exactly once before a transfer gap or FX spread is calculated.
- **Consequence:** a manually entered value cannot be presented as a bank fact, and unexplained residuals block reconciled status.

## MW-016: Private transaction text stays out of URLs

- **Status:** accepted
- **Date:** 2026-09-03
- **Decision:** Search free-form transaction descriptions through a same-origin, CSRF-protected POST with parameterized SQL and bounded server pagination. Do not encode search text in GET parameters or navigation state that reaches access logs.
- **Consequence:** the transaction screen can search the complete local ledger while private descriptions stay out of URLs, browser history, analytics, and standard request logs.

## MW-017: A ledger entry belongs to at most one movement group

- **Status:** accepted
- **Date:** 2026-09-03
- **Decision:** Enforce unique movement-leg ownership at the database layer. A statement fee represented by its own debit entry may become an explicit fee leg of one confirmed same-currency movement only.
- **Consequence:** conservation includes that source-side debit exactly once, while the explicit fee component explains it exactly once; pending candidates or prior group ownership block attachment.

## MW-018: Autonomous analysis replaces the manual-review product loop

- **Status:** accepted
- **Date:** 2026-09-03
- **Decision:** After each import, run undated evidence recovery, movement discovery, global one-to-one reconciliation, deterministic cost analysis, entry classification, and personal categorization automatically. The primary UI has no Review queue.
- **Consequence:** hard or uniquely supported movement evidence is applied without user work; ambiguous or weak evidence is rejected from totals and reported only as an audit limitation. The pipeline being complete does not imply that an individual unexplained gap is reconciled.

## MW-019: Provider-described FX may stop at a source pool

- **Status:** accepted
- **Date:** 2026-09-03
- **Decision:** When a PrivatBank journal description proves the sold-currency amount and stated execution rate and the row amount proves the received proceeds, create a one-sided FX movement group without inventing a missing source account or debit. Validate the statement equation and benchmark the execution rate through the deterministic FX service.
- **Consequence:** Money Flow can show the confirmed currency sale from an aggregate FOP source pool to the evidenced destination account. The group keeps its provider provenance, remains distinct from a fully paired transfer, and is not considered fully reconciled when a residual gap remains.

## MW-020: Monobank files join the canonical ledger

- **Status:** accepted
- **Date:** 2026-09-04
- **Decision:** Import the authorized Monobank personal XLS statements through a provider-specific adapter while retaining the same canonical accounts, ledger, movement, cost, and category contracts used by PrivatBank.
- **Consequence:** same-bank and cross-provider movements are matched in one global pass; Monobank fees remain provider evidence and do not become a second debit when already included in settlement amounts.

## MW-021: Report currencies convert rather than filter

- **Status:** accepted
- **Date:** 2026-09-04
- **Decision:** Preserve every native amount and materialize reproducible daily UAH, EUR, and USD reporting values from official ECB/NBU evidence using decimal arithmetic. The report-currency selector converts the complete eligible ledger; native-currency filtering is a separate transaction concern.
- **Consequence:** missing rates are surfaced and excluded from converted totals, never replaced by a 1:1 fallback. The rolling two-year window is anchored to the current date rather than stale statement recency.

## MW-022: Cash is an evidence-backed account domain

- **Status:** accepted
- **Date:** 2026-09-04
- **Decision:** Represent cash as separate currency accounts with an explicit zero opening position at the accepted two-year boundary. Only proven withdrawals, deposits, exchanges, or future explicit manual entries may change it.
- **Consequence:** a cash withdrawal is an internal movement rather than terminal spending, and absent counterpart evidence remains visible instead of becoming invented cash consumption or deposit lineage.

## MW-023: Daily workspace separates stock, flow and planning evidence

- **Status:** accepted
- **Date:** 2026-09-04
- **Decision:** Implement the accepted revised UI first using read-only bank-backed projections. Capital has a separate as-of date and a partial known-position subtotal; monthly Insights have their own comparison window, independently of the two-year history explorer.
- **Consequence:** the app does not label incomplete assets/debts complete Net Worth, invent journal balances, or call period income minus spending a capital change. Cached stock valuations disclose publication dates and staleness. Statement fees, derived gaps, FX estimates and unexplained residuals remain separate and drillable. Manual workbook position migration precedes persisted plans and goals; no demo data enters the working store.

## MW-024: Monthly manual positions supplement the canonical bank ledger

- **Status:** accepted implementation of the approved workbook follow-on phase
- **Date:** 2026-09-07
- **Decision:** Import direct monthly position cells as immutable, lineage-stable observations with exhaustive source-cell dispositions and encrypted original bytes. Link proven account/cash identities once; preserve distinct manual bank positions without inventing transfer counterparts. Keep month precision and use month-end only as an explicit eligibility boundary. Same-month bank evidence has precedence; conflicting manual values stay unresolved.
- **Consequence:** Capital gains historical positions and source/reconciliation inspectors without changing bank transactions, categories, movements or fee calculations. Formulas, totals, planning rows and goals do not create assets or ledger entries. Existing local exports need no new Google integration; their bytes remain unchanged and source permissions are restricted. Budget/goal migration and full estate/debt coverage remain separate work.

## MW-025: Money Waves replaces the home screen with one account map

- **Status:** accepted
- **Date:** 2026-09-07
- **Decision:** Start the approved UI replacement with a read-only account-flow map. Preserve each account identity and existing financial evidence; aggregate direct confirmed links without assigning pooled-fund lineage. Multi-leg movements use junctions, provider-only FX uses a labelled source pool, and absent counterparts remain dashed boundaries. Retain the left navigation and separate transaction workspace.
- **Consequence:** Amounts and cost evidence appear inline, while the latest eligible balances carry their own dates. Existing fees, derived gaps, FX estimates and unexplained residuals are never merged into one fee claim. No financial writes, migration, rematching, event/vacation grouping or category editing is authorized by this presentation change. The production Host/Origin/CSRF boundary remains unchanged; browser tests may use an explicitly isolated synthetic development port.

## MW-026: Rebuilt financial workspace supersedes the map-first interface

- **Status:** rejected by the requester; presentation superseded by MW-027
- **Date:** 2026-09-08
- **Decision:** Replace the primary page system with live account/cash balances, dated history, inline transaction and movement journals, expense analysis and a separate cost center. Preserve the encrypted financial engine, exact minor-unit amounts and source precedence. No default side inspector, standalone prototype or vacation/event grouping.
- **Interaction:** Existing private search supports Ukrainian letter case and literal punctuation. Unassigned expenses and missing valuations remain visible. Manual category selection and atomic custom-category creation use the existing protected categorization endpoint; no new public API or schema. User actions affect only the selected expense and maintain auditable provenance. The rebuild itself does not apply private audit proposals or alter financial records.
- **Verification boundary:** Real-store readback is read-only and compared against source/database digests. Category writes are tested only in isolated synthetic storage. Product builds exclude ignored financial data and local audit/task scripts. All original source material and prior audit results remain local and unchanged.

## MW-027: Delete the rejected UI; replace it with a financial workbook

- **Status:** implementation under the explicit from-scratch request; not a claim of usability acceptance
- **Date:** 2026-09-08
- **Decision:** Delete the prior visual layer without archiving it. Build new presentation code under `src/ui`, preserving the financial domain, encrypted store, security transport and read models. Use a balance sheet as home, horizontal chapter navigation, inline sent/received/cost movement rows, a category-month spending matrix and a dense editable-category transaction journal.
- **Boundary:** No database writes during real-data verification, no audit-correction application, imports, rematching, migrations, new APIs, external dependencies or Git mutations. Setup/import/category interactions are tested only on isolated synthetic data. Financial backups and source documents are unrelated to the rejected UI and remain protected.

## MW-028: Compact account list and one shared calendar month

- **Status:** implemented following explicit feedback; visual acceptance remains with the requester
- **Date:** 2026-09-09
- **Decision:** Replace the default account matrix, graph, banners and decorative chrome with a plain grouped account list showing one reporting-currency balance per row. Dates, native amounts, evidence and history expand on request. One shared month picker and previous/next arrows govern every financial chapter; no rolling-day or page-specific date selectors remain in the UI.
- **Boundary:** Calendar reads use inclusive month-start and exclusive next-month-start before aggregation and pagination. Accounts use month-end capped at today. Legacy rolling periods remain internal compatibility inputs. No financial record, schema, source, audit correction or matching rule changes. Read-only integrity checks and browser verification are required.

## MW-029: Remove the website; retain data and processing

- **Status:** accepted by explicit requester instruction
- **Date:** 2026-09-09
- **Decision:** Remove the website, HTTP endpoints, Next/React runtime, web-only tests/configuration and generated site output. Stop the local site server; do not archive the rejected UI or create a replacement page. Retain the TypeScript processing core, CLI operators, encrypted storage, Keychain/recovery, imports, matching, categories, cash, costs, valuations and read models.
- **Boundary:** Preserve source files, database, financial backups, private reports and audit work. No financial corrections, imports, derivation runs, migrations, external calls or Git mutations as part of removal. Synthetic processing tests and data-integrity checks replace website acceptance.
- **Requirements:** [High-level product requirements](requirements.md) describe the intended financial outcome without inheriting a rejected design. A new interface needs a separate explicit request. This supersedes the web-runtime portion of MW-007 and the presentation/HTTP decisions; financial rules, privacy and calendar-month reporting remain intact.


## MW-030: Approved report-style local workspace

- **Status:** explicitly requested after design approval
- **Date:** 2026-09-10
- **Decision:** Add a local, framework-independent website over the retained processing core. Share one month/year selector across overview, budgets, trips/events, purchases and expense corrections. Use the approved report layout and EUR reporting. This supersedes MW-029's website removal boundary for this interface.
- **Persistence:** SQLCipher holds an immutable, provenance-linked verified report projection and a separate revisioned workspace overlay. Budgets have an effective month. Collections annotate existing payments; their totals never become additional ledger expenses. Exact category edits and exclusions remain reversible and scoped. Bank/source records remain unchanged.
- **Read boundary:** Capital is read from the canonical financial core with its existing evidence precedence. Expense history is the dated, corrected report snapshot, identified separately from capital. A ledger fingerprint detects a changed source at startup; restarting or editing plans does not silently rerun imports or infer new matches. A new report import is an explicit operator action, never a page-read side effect.
- **Transport:** Native Node HTTP on loopback only, exact Host and Origin checks, random HttpOnly SameSite session, CSRF checks for writes, restricted static files, no external assets or telemetry, and no financial browser persistence. Printing uses the same current report state as the website.
- **Verification:** Synthetic calculation, persistence and protected HTTP tests; real-store source fingerprints and a verified encrypted backup before migration/import; browser acceptance on real reads and isolated synthetic writes. No external publication or Git mutations authorized.
## MW-031 — Captured public wallet NAV in the local workspace

The requester explicitly authorized reading their supplied NEAR Pikespeak and Ethereum Etherscan pages and adding these wallets to Net Worth. Wallet identities and observations stay in encrypted storage and ignored evidence files. This scope permits reading those public wallet pages, not wallet signing, private keys, account discovery or sharing bank data.

One timestamped provider NAV per wallet contributes once. Token/staking breakdowns explain that NAV and are not additional assets. Immutable observations preserve source URLs and evidence hashes; explicit local import verifies evidence and a recoverable backup. Page reads have no external calls or implicit price refresh. USD values use dated cached official USD/EUR rates; missing rates remain unvalued. Current capital and period-end capital are separate selections, and observations never backfill earlier months. The displayed bank/cash history remains labelled as excluding crypto until historical crypto observations are available.

## MW-032: Private stable hosting on ExMachina

- **Date:** 2026-09-10
- **Authorization:** the requester explicitly asked to host a stable version on ExMachina for their mobile browser.
- **Boundary:** the code and SQLCipher store remain on ExMachina. Tailscale Serve provides private HTTPS to the owner's devices; no public Funnel, third-party hosting, telemetry or financial API integration is authorized.
- **Transport:** the stable Node 24 service still binds only to loopback. Explicit paired `MONEYWAVE_TAILSCALE_ORIGIN` and `MONEYWAVE_TAILSCALE_LOGIN` settings enable one exact HTTPS origin and owner login. This mode rejects local Host bypasses, requires Serve's owner identity on every request and retains Origin/session/CSRF checks with a Secure `__Host-` cookie. Forwarded host/protocol headers are not authority. The default unconfigured CLI remains localhost-only.
- **Operation:** a launchd user service runs a versioned local code/dependency snapshot using the existing encrypted data directory. Workspace edits take effect only after an explicit stable release update. Login/unlocked Keychain and an awake, online Mac are operational prerequisites. Stop only this Serve port and launchd label to roll back; other apps remain untouched.

## MW-033: Confirmed categories survive reprocessing

- **Date:** 2026-09-11
- **Authorization:** the requester asked to persist every agreed category rule and report the verification result.
- **Decision:** One versioned [category policy](category-rules.md) governs deterministic merchant rules, canonical category consolidation and explicit report refresh. Existing encrypted `categorization_rules` stores exact confirmed entry decisions; the optional workspace adapter synchronizes current decisions before processing. No schema migration or new service boundary is needed.
- **Preservation:** manual assignments, workspace corrections, budget versions, aliases and trip membership survive. Confirmed FX exclusions are identity-specific and create no matching leg or balance. No amount-only inference is permitted. Source evidence remains immutable and previous derived assignments remain auditable.
- **Verification:** synthetic regressions and isolated encrypted preparation/classification replay with AI disabled, followed by a verified-backup rule installation and readback. Full imports, movement discovery, external calls and a stable release update are separate operations.

# MoneyWave

Private personal-finance workspace: a local report-style website over an encrypted, framework-independent processing core.

## Requirements

[High-level product requirements](docs/requirements.md): accounts and cash, money movement, meaningful categories, monthly reporting, net worth and the cost of moving money. The approved local workspace is defined by MW-030.

## Retained

- Original statements, encrypted SQLCipher database, financial backups and private audit reports under ignored `data/` paths.
- PrivatBank FOP/personal, monobank, Erste, Wise and Revolut file adapters; manual monthly position imports.
- Immutable evidence, deduplication, reconciliation, movement matching and classification.
- Evidence-backed cash, deterministic fee/FX calculations and daily UAH/EUR/USD valuations.
- Category rules, authorized sanitized Codex categorization, and read-only account/transaction/report projections.
- Keychain/recovery, verified backups and synthetic processing tests.

Unknown balances, unmatched movements and missing rates remain unknown. Report corrections and manual workspace edits remain separate from original bank records.

## Local commands

Use Node 24 and the pinned pnpm version. `pnpm install` installs processing dependencies; `pnpm verify` runs lint, typecheck, synthetic tests and security checks. The website uses native Node HTTP and local static assets; no framework build or external service is needed.

- `pnpm start`: open the local workspace at `http://127.0.0.1:43821/`. Requires the existing Keychain-backed database and an initialized report.
- Stable mobile access on ExMachina: `https://exmachina.tail3a0b66.ts.net:9443/`, with Tailscale connected as the owner. See [private hosting](#private-hosting-on-exmachina).
- `pnpm workspace:seed <ignored-local-report.json>`: validate and initialize the report projection; `--refresh` imports a later verified report while retaining compatible user edits. Source checks and a verified encrypted backup precede the write.
- `pnpm keychain:build`: build the local Swift Keychain helper.
- `pnpm verify:real-data`: opt-in local parser checks with safe result codes only.
- `pnpm import:manual-positions <local-xlsx>`: preview manual monthly positions; `--commit` enables the separately authorized import.
- `node --import tsx scripts/import-foreign-statements.ts`: preview the supplied foreign statements; committing requires explicit `--commit --confirm-same-manual-accounts` authorization.
- `pnpm analyze:finance` / `pnpm analyze:privatebank`: **mutating** import/derivation operators with verified backups. These can invoke accepted rate/categorization flows; they are not read-only verification commands.
- `pnpm verify:codex-subscription`: opt-in external check using synthetic text and existing Codex sign-in; consumes subscription usage.

For private source paths, invoke the corresponding script directly to avoid package-manager argument echoes. Database and recovery keys never belong in arguments or environment variables.

## Private hosting on ExMachina

MW-032 authorizes owner-only Tailscale access. The stable website runs in the local `moneywave-stage` container, published only on `127.0.0.1:43822`; Tailscale Serve maps private HTTPS port 9443 to it. Launchd `local.moneywave.stage` supervises it and provides access to the shared database through an unlogged local pipe; the database key stays in macOS Keychain and the host process. Its `caffeinate -s` wrapper prevents AC sleep. The Mac must remain online and logged in with its Keychain available.

Use `pnpm stage:deploy` to verify and install an immutable local image, `pnpm stage:status` to inspect it, and `pnpm stage:rollback` for the previous image. The container and source preview share the existing encrypted database; never copy over, reseed or migrate it for a code release. The owner's login and deployment configuration remain ignored local files. See [the staging runbook](docs/staging.md) for backup, network, restart and acceptance details.

- Check: `pnpm stage:status` and `tailscale serve status`.
- Restart: `docker --context colima restart moneywave-stage`, wait for the supervisor to unlock it, then reload the browser to renew its session.
- Stop mobile exposure: `tailscale serve --https=9443 off`.
- Stop the app: `launchctl bootout gui/$(id -u)/local.moneywave.stage`, then `docker --context colima stop moneywave-stage`.

Do not reset the shared Tailscale Serve configuration: other apps use its other ports. The financial store remains shared with the local workspace and protected by its existing revision checks.

## Privacy

Financial data stays local and ignored by Git. Preserve source bytes and keep reports separate from originals. SQLCipher/Keychain and backup contracts remain unchanged. Direct application network access is deny-by-default; only previously reviewed bank/public-rate endpoints are allowed. The separately authorized Codex path receives bounded sanitized merchant labels and category codes, never raw records, accounts, dates, amounts, balances or totals. No local model is required.

Vault-Tec contains only project metadata. Do not upload financial material or extend external access without specific authorization.

## Documentation

- [Product scope](docs/product.md)
- [Architecture](docs/architecture.md)
- [Decisions](docs/decisions.md)
- [Data handling](data/README.md)
- [Agent instructions](AGENTS.md)


## Workspace behavior

Five chapters share a month/year selector: overview, budget, trips/events, purchases and transactions. Capital uses canonical dated positions; spending uses the explicitly imported corrected report. The UI shows the statement coverage and flags a changed ledger on startup. It never automatically imports bank data, refreshes FX, or sends financial data elsewhere.

Category edits, effective-month budget limits, collections and revision history persist in SQLCipher. Existing payments can belong to a purchase and a trip without double counting. Explicit manual payments are separate user facts; linking a bank debit requires removing the manual amount first. Future events can have budgets, but future manual payments are rejected. Missing stock coverage does not become a complete Net Worth claim.

The print view uses the same selected period and current edits; its PDF/print action uses the browser's print dialog. Source bank files remain immutable. Stocks are not yet connected.

The crypto box includes captured Pikespeak NEAR NAV and Etherscan Ethereum holdings in current Net Worth. Each wallet contributes once; staking and token breakdowns are explanatory. Current capital and period-end capital have separate controls. The chart is explicitly bank/cash history, without retroactively invented crypto balances. Explorer observations show capture dates; reloading the site does not refresh market prices.

Explicit local refresh: `node --import tsx scripts/import-crypto-observations.ts data/<captured-observations.json>` under Node 24. The input is an array of `{ observation, evidencePath }`; the schema is in `src/server/workspace/crypto.ts`. Each observation has the exact source URL/account, capture timestamp, USD NAV in cents, component breakdown and SHA-256 of its ignored local evidence file. The operator validates source identity and NAV reconciliation, verifies an encrypted backup, preserves prior observations and reads back the saved records. Wallet identifiers never belong in tracked files. Missing USD/EUR rates remain unvalued rather than defaulting to parity. No external calls, keys, signing or automatic synchronization occur on website reads.

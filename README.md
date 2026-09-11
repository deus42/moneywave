# MoneyWave

Private personal-finance workspace: an encrypted, framework-independent processing core.

## Requirements

[High-level product requirements](docs/requirements.md): accounts and cash, money movement, meaningful categories, monthly reporting, net worth and the cost of moving money.

## Retained

- Original statements, encrypted SQLCipher database, financial backups and private audit reports under ignored `data/` paths.
- PrivatBank FOP/personal, monobank, Erste, Wise and Revolut file adapters; manual monthly position imports.
- Immutable evidence, deduplication, reconciliation, movement matching and classification.
- Evidence-backed cash, deterministic fee/FX calculations and daily UAH/EUR/USD valuations.
- Category rules, authorized sanitized Codex categorization, and read-only account/transaction/report projections.
- Keychain/recovery, verified backups and synthetic processing tests.

Unknown balances, unmatched movements and missing rates remain unknown.

## Local commands

Use Node 24 and the pinned pnpm version. `pnpm install` installs processing dependencies; `pnpm verify` runs lint, typecheck, synthetic tests and security checks.

- `pnpm keychain:build`: build the local Swift Keychain helper.
- `pnpm verify:real-data`: opt-in local parser checks with safe result codes only.
- `pnpm import:manual-positions <local-xlsx>`: preview manual monthly positions; `--commit` enables the separately authorized import.
- `node --import tsx scripts/import-foreign-statements.ts`: preview the supplied foreign statements; committing requires explicit `--commit --confirm-same-manual-accounts` authorization.
- `pnpm analyze:finance` / `pnpm analyze:privatebank`: **mutating** import/derivation operators with verified backups. These can invoke accepted rate/categorization flows; they are not read-only verification commands.
- `pnpm verify:codex-subscription`: opt-in external check using synthetic text and existing Codex sign-in; consumes subscription usage.

For private source paths, invoke the corresponding script directly to avoid package-manager argument echoes. Database and recovery keys never belong in arguments or environment variables.

## Privacy

Financial data stays local and ignored by Git. Preserve source bytes and keep reports separate from originals. SQLCipher/Keychain and backup contracts remain unchanged. Direct application network access is deny-by-default; only previously reviewed bank/public-rate endpoints are allowed. The separately authorized Codex path receives bounded sanitized merchant labels and category codes, never raw records, accounts, dates, amounts, balances or totals. No local model is required.

Vault-Tec contains only project metadata. Do not upload financial material or extend external access without specific authorization.

## Documentation

- [Product scope](docs/product.md)
- [Architecture](docs/architecture.md)
- [Decisions](docs/decisions.md)
- [Data handling](data/README.md)
- [Agent instructions](AGENTS.md)

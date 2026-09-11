export const migration0011 = {
  version: 11,
  name: "monobank_valuations_cash",
  sql: `
    CREATE TABLE provider_fee_evidence (
      id TEXT PRIMARY KEY,
      transaction_evidence_id TEXT NOT NULL UNIQUE REFERENCES transaction_evidence(id),
      amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
      currency TEXT NOT NULL CHECK (length(currency) BETWEEN 3 AND 8 AND currency = upper(currency)),
      included_in_settlement INTEGER NOT NULL DEFAULT 1 CHECK (included_in_settlement = 1),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ) STRICT;

    CREATE TABLE ledger_entry_valuations (
      ledger_entry_id TEXT NOT NULL REFERENCES ledger_entries(id),
      source_currency TEXT NOT NULL CHECK (length(source_currency) BETWEEN 3 AND 8 AND source_currency = upper(source_currency)),
      target_currency TEXT NOT NULL CHECK (length(target_currency) BETWEEN 3 AND 8 AND target_currency = upper(target_currency)),
      converted_amount_minor INTEGER NOT NULL,
      requested_date TEXT NOT NULL CHECK (length(requested_date) = 10),
      rate_text TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('identity', 'ECB', 'NBU')),
      publication_date TEXT NOT NULL CHECK (length(publication_date) = 10),
      formula_version TEXT NOT NULL,
      valued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (ledger_entry_id, target_currency),
      CHECK ((source_currency = target_currency AND source = 'identity' AND rate_text = '1') OR source_currency <> target_currency)
    ) STRICT;
    CREATE INDEX ledger_entry_valuations_target_date
      ON ledger_entry_valuations(target_currency, requested_date);

    CREATE TABLE balance_snapshot_valuations (
      balance_snapshot_id TEXT NOT NULL REFERENCES balance_snapshots(id),
      source_currency TEXT NOT NULL CHECK (length(source_currency) BETWEEN 3 AND 8 AND source_currency = upper(source_currency)),
      target_currency TEXT NOT NULL CHECK (length(target_currency) BETWEEN 3 AND 8 AND target_currency = upper(target_currency)),
      converted_amount_minor INTEGER NOT NULL,
      requested_date TEXT NOT NULL CHECK (length(requested_date) = 10),
      rate_text TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('identity', 'ECB', 'NBU')),
      publication_date TEXT NOT NULL CHECK (length(publication_date) = 10),
      formula_version TEXT NOT NULL,
      valued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (balance_snapshot_id, target_currency),
      CHECK ((source_currency = target_currency AND source = 'identity' AND rate_text = '1') OR source_currency <> target_currency)
    ) STRICT;
    CREATE INDEX balance_snapshot_valuations_target_date
      ON balance_snapshot_valuations(target_currency, requested_date);

    CREATE TABLE cost_component_valuations (
      cost_component_id TEXT NOT NULL REFERENCES cost_components(id),
      source_currency TEXT NOT NULL CHECK (length(source_currency) BETWEEN 3 AND 8 AND source_currency = upper(source_currency)),
      target_currency TEXT NOT NULL CHECK (length(target_currency) BETWEEN 3 AND 8 AND target_currency = upper(target_currency)),
      converted_amount_minor INTEGER NOT NULL,
      requested_date TEXT NOT NULL CHECK (length(requested_date) = 10),
      rate_text TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('identity', 'ECB', 'NBU')),
      publication_date TEXT NOT NULL CHECK (length(publication_date) = 10),
      formula_version TEXT NOT NULL,
      valued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (cost_component_id, target_currency),
      CHECK ((source_currency = target_currency AND source = 'identity' AND rate_text = '1') OR source_currency <> target_currency)
    ) STRICT;
    CREATE INDEX cost_component_valuations_target_date
      ON cost_component_valuations(target_currency, requested_date);

    CREATE TABLE category_aliases (
      id TEXT PRIMARY KEY,
      provider_code TEXT NOT NULL DEFAULT '*',
      normalized_alias TEXT NOT NULL CHECK (length(normalized_alias) BETWEEN 1 AND 240),
      category_id TEXT NOT NULL REFERENCES categories(id),
      priority INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE (provider_code, normalized_alias)
    ) STRICT;
    CREATE INDEX category_aliases_lookup
      ON category_aliases(provider_code, normalized_alias, enabled, priority DESC);

    CREATE TABLE cash_opening_balances (
      account_id TEXT PRIMARY KEY REFERENCES accounts(id),
      opening_date TEXT NOT NULL CHECK (length(opening_date) = 10),
      balance_minor INTEGER NOT NULL,
      currency TEXT NOT NULL CHECK (length(currency) BETWEEN 3 AND 8 AND currency = upper(currency)),
      evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('user_asserted', 'statement', 'manual_document')),
      established_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ) STRICT;
  `,
} as const;

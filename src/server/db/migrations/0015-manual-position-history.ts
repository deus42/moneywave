export const migration0015 = {
  version: 15,
  name: "manual_position_history",
  sql: `
    CREATE TABLE manual_workbooks (
      id TEXT PRIMARY KEY,
      contract_version TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ) STRICT;
    CREATE TABLE manual_import_batches (
      id TEXT PRIMARY KEY,
      lineage_id TEXT NOT NULL REFERENCES manual_workbooks(id),
      artifact_id TEXT NOT NULL UNIQUE REFERENCES import_artifacts(id),
      cell_count INTEGER NOT NULL CHECK (cell_count > 0),
      backup_status TEXT NOT NULL CHECK (backup_status IN ('pending','verified','failed')),
      audit_counts_json TEXT NOT NULL DEFAULT '{}',
      imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ) STRICT;
    CREATE TABLE manual_position_series (
      id TEXT PRIMARY KEY,
      lineage_id TEXT NOT NULL REFERENCES manual_workbooks(id),
      label_key TEXT NOT NULL CHECK (length(label_key) = 64),
      display_name TEXT NOT NULL,
      provider_code TEXT NOT NULL,
      position_kind TEXT NOT NULL CHECK (position_kind IN ('bank','cash')),
      currency TEXT NOT NULL CHECK (currency IN ('UAH','EUR','USD')),
      account_id TEXT REFERENCES accounts(id),
      UNIQUE(lineage_id, label_key, currency)
    ) STRICT;
    CREATE UNIQUE INDEX manual_linked_account ON manual_position_series(lineage_id, account_id) WHERE account_id IS NOT NULL;
    CREATE TABLE manual_position_facts (
      id TEXT PRIMARY KEY,
      series_id TEXT NOT NULL REFERENCES manual_position_series(id),
      period TEXT NOT NULL CHECK (length(period) = 7),
      precision TEXT NOT NULL DEFAULT 'month' CHECK (precision = 'month'),
      amount_minor INTEGER NOT NULL,
      UNIQUE(series_id, period, amount_minor)
    ) STRICT;
    CREATE INDEX manual_position_period ON manual_position_facts(series_id, period DESC);
    CREATE TABLE manual_source_cells (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL REFERENCES manual_import_batches(id),
      sheet_name TEXT NOT NULL,
      cell_address TEXT NOT NULL,
      disposition TEXT NOT NULL CHECK (disposition IN ('structural','formula_only','manual_fact','linked_to_ledger','unresolved','rejected')),
      reason_code TEXT,
      fact_id TEXT REFERENCES manual_position_facts(id),
      CHECK (disposition NOT IN ('unresolved','rejected') OR reason_code IS NOT NULL),
      CHECK (disposition NOT IN ('manual_fact','linked_to_ledger') OR fact_id IS NOT NULL),
      UNIQUE(batch_id, sheet_name, cell_address)
    ) STRICT;
    CREATE INDEX manual_cell_fact ON manual_source_cells(fact_id);
  `,
} as const;

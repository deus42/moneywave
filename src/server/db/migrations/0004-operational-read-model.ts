export const migration0004 = {
  version: 4,
  name: "operational_read_model",
  sql: `
    ALTER TABLE transaction_evidence ADD COLUMN source_amount_minor INTEGER;
    ALTER TABLE transaction_evidence ADD COLUMN source_currency TEXT;
    ALTER TABLE transaction_evidence ADD COLUMN instrument_id TEXT REFERENCES account_instruments(id);

    CREATE TABLE reconciliation_conflicts (
      id TEXT PRIMARY KEY,
      source_record_id TEXT NOT NULL REFERENCES source_records(id),
      ledger_entry_id TEXT REFERENCES ledger_entries(id),
      reason_code TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
      safe_details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      reviewed_at TEXT
    ) STRICT;

    CREATE UNIQUE INDEX balance_snapshots_source_account
      ON balance_snapshots(source_record_id, account_id)
      WHERE source_record_id IS NOT NULL;
    CREATE INDEX ledger_entries_occurred_at ON ledger_entries(occurred_at DESC);
    CREATE INDEX ledger_entries_account_date ON ledger_entries(account_id, occurred_at DESC);
    CREATE INDEX movement_candidates_status ON movement_candidates(status, reviewed_at);
    CREATE INDEX reconciliation_conflicts_status ON reconciliation_conflicts(status, created_at);
    CREATE INDEX category_assignments_entry_date ON category_assignments(ledger_entry_id, assigned_at DESC);
  `,
} as const;

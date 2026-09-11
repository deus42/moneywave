export const migration0006 = {
  version: 6,
  name: "undated_observations",
  sql: `
    CREATE TABLE unresolved_observations (
      id TEXT PRIMARY KEY,
      source_record_id TEXT NOT NULL REFERENCES source_records(id),
      position INTEGER NOT NULL CHECK (position >= 0),
      account_id TEXT NOT NULL REFERENCES accounts(id),
      instrument_id TEXT REFERENCES account_instruments(id),
      amount_minor INTEGER NOT NULL,
      currency TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('debit', 'credit')),
      own_identifier_hmac TEXT CHECK (own_identifier_hmac IS NULL OR length(own_identifier_hmac) = 64),
      counterparty_identifier_hmac TEXT CHECK (counterparty_identifier_hmac IS NULL OR length(counterparty_identifier_hmac) = 64),
      provider_reference TEXT,
      private_description TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved')),
      resolved_ledger_entry_id TEXT REFERENCES ledger_entries(id),
      resolution_kind TEXT CHECK (resolution_kind IS NULL OR resolution_kind IN ('statement_match', 'manual')),
      resolved_at TEXT,
      UNIQUE(source_record_id, position),
      CHECK ((direction = 'debit' AND amount_minor <= 0) OR (direction = 'credit' AND amount_minor >= 0)),
      CHECK ((status = 'pending' AND resolved_ledger_entry_id IS NULL AND resolution_kind IS NULL AND resolved_at IS NULL)
        OR (status = 'resolved' AND resolved_ledger_entry_id IS NOT NULL AND resolution_kind IS NOT NULL AND resolved_at IS NOT NULL))
    ) STRICT;

    CREATE INDEX unresolved_observations_status
      ON unresolved_observations(status, source_record_id, position);
  `,
} as const;

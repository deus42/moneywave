export const migration0001 = {
  version: 1,
  name: "foundation_import_ledger",
  sql: `
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ) STRICT;

    CREATE TABLE providers (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL
    ) STRICT;

    CREATE TABLE connections (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL REFERENCES providers(id),
      connection_kind TEXT NOT NULL CHECK (connection_kind IN ('file', 'api')),
      capability_status TEXT NOT NULL DEFAULT 'unknown',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ) STRICT;

    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL REFERENCES providers(id),
      owner_scope TEXT NOT NULL CHECK (owner_scope IN ('PERSONAL', 'SOLE_PROPRIETOR')),
      account_type TEXT NOT NULL,
      currency TEXT NOT NULL,
      display_name TEXT NOT NULL,
      identifier_hmac TEXT UNIQUE CHECK (identifier_hmac IS NULL OR length(identifier_hmac) = 64),
      balance_evidence_status TEXT NOT NULL DEFAULT 'unavailable',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ) STRICT;

    CREATE TABLE account_instruments (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      instrument_kind TEXT NOT NULL,
      identifier_hmac TEXT NOT NULL UNIQUE CHECK (length(identifier_hmac) = 64),
      masked_display TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ) STRICT;

    CREATE TABLE import_artifacts (
      id TEXT PRIMARY KEY,
      sha256 TEXT NOT NULL UNIQUE CHECK (length(sha256) = 64),
      encrypted_bytes BLOB NOT NULL,
      size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
      parser_kind TEXT NOT NULL,
      parser_version TEXT NOT NULL,
      imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ) STRICT;

    CREATE TABLE import_batches (
      id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL REFERENCES import_artifacts(id),
      status TEXT NOT NULL CHECK (status IN ('preview', 'committed', 'rolled_back', 'failed')),
      row_count INTEGER NOT NULL CHECK (row_count >= 0),
      posted_count INTEGER NOT NULL DEFAULT 0,
      unresolved_count INTEGER NOT NULL DEFAULT 0,
      rejected_count INTEGER NOT NULL DEFAULT 0,
      committed_at TEXT
    ) STRICT;

    CREATE TABLE source_records (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL REFERENCES import_batches(id),
      source_row_number INTEGER NOT NULL CHECK (source_row_number > 0),
      dedupe_fingerprint TEXT NOT NULL CHECK (length(dedupe_fingerprint) = 64),
      row_state TEXT NOT NULL CHECK (row_state IN ('posted', 'non_posted', 'unresolved', 'rejected')),
      reason_code TEXT,
      duplicate_of_source_record_id TEXT REFERENCES source_records(id),
      source_metadata_json TEXT NOT NULL DEFAULT '{}',
      UNIQUE(batch_id, source_row_number)
    ) STRICT;
    CREATE INDEX source_records_dedupe ON source_records(dedupe_fingerprint);

    CREATE TABLE ledger_entries (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      amount_minor INTEGER NOT NULL,
      currency TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('debit', 'credit')),
      occurred_at TEXT NOT NULL,
      entry_kind TEXT NOT NULL,
      private_description TEXT,
      reconciliation_status TEXT NOT NULL DEFAULT 'unlinked',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      CHECK ((direction = 'debit' AND amount_minor <= 0) OR (direction = 'credit' AND amount_minor >= 0))
    ) STRICT;

    CREATE TABLE transaction_evidence (
      id TEXT PRIMARY KEY,
      ledger_entry_id TEXT NOT NULL REFERENCES ledger_entries(id),
      source_record_id TEXT NOT NULL REFERENCES source_records(id),
      observed_amount_minor INTEGER NOT NULL,
      observed_currency TEXT NOT NULL,
      observed_direction TEXT NOT NULL CHECK (observed_direction IN ('debit', 'credit')),
      own_identifier_hmac TEXT CHECK (own_identifier_hmac IS NULL OR length(own_identifier_hmac) = 64),
      counterparty_identifier_hmac TEXT CHECK (counterparty_identifier_hmac IS NULL OR length(counterparty_identifier_hmac) = 64),
      provider_reference TEXT,
      UNIQUE(ledger_entry_id, source_record_id)
    ) STRICT;
  `,
} as const;

export const migration0003 = {
  version: 3,
  name: "balance_sync_audit",
  sql: `
    CREATE TABLE balance_snapshots (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      balance_minor INTEGER NOT NULL,
      currency TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('statement', 'api', 'manual')),
      source_record_id TEXT REFERENCES source_records(id)
    ) STRICT;

    CREATE TABLE sync_cursors (
      id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL REFERENCES connections(id),
      account_id TEXT REFERENCES accounts(id),
      cursor_value TEXT NOT NULL,
      window_start TEXT,
      window_end TEXT,
      advanced_at TEXT NOT NULL,
      UNIQUE(connection_id, account_id)
    ) STRICT;

    CREATE TABLE fx_rate_cache (
      base_currency TEXT NOT NULL,
      quote_currency TEXT NOT NULL,
      requested_date TEXT NOT NULL,
      rate_text TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('ECB', 'NBU')),
      publication_date TEXT NOT NULL,
      cached_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY(base_currency, quote_currency, requested_date)
    ) STRICT;

    CREATE TABLE audit_events (
      id TEXT PRIMARY KEY,
      event_code TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      safe_details_json TEXT NOT NULL DEFAULT '{}',
      occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ) STRICT;

    INSERT INTO categories (id, scope, code, display_name, editable) VALUES
      ('business-gross-income', 'business', 'gross_income', 'Gross income', 0),
      ('business-tax', 'business', 'tax', 'Tax', 0),
      ('business-mandatory', 'business', 'mandatory_contributions', 'Mandatory contributions', 0),
      ('business-expense', 'business', 'business_expense', 'Business expense', 1),
      ('business-owner-draw', 'business', 'owner_draw', 'Owner draw', 0),
      ('business-bank-fee', 'business', 'bank_fee', 'Bank fee', 0),
      ('business-fx-cost', 'business', 'fx_cost', 'FX cost', 0),
      ('personal-income', 'personal', 'personal_income', 'Income', 1),
      ('personal-housing', 'personal', 'housing', 'Housing', 1),
      ('personal-food', 'personal', 'food', 'Food', 1),
      ('personal-transport', 'personal', 'transport', 'Transport', 1),
      ('personal-health', 'personal', 'health', 'Health', 1),
      ('personal-entertainment', 'personal', 'entertainment', 'Entertainment', 1),
      ('personal-other', 'personal', 'other', 'Other', 1);
  `,
} as const;

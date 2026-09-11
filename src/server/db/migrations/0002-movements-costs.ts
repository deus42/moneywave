export const migration0002 = {
  version: 2,
  name: "movements_costs_categories",
  sql: `
    CREATE TABLE movement_groups (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('candidate', 'confirmed', 'reconciled', 'unlinked')),
      evidence_kind TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      confirmed_at TEXT
    ) STRICT;

    CREATE TABLE movement_legs (
      id TEXT PRIMARY KEY,
      movement_group_id TEXT NOT NULL REFERENCES movement_groups(id),
      ledger_entry_id TEXT NOT NULL REFERENCES ledger_entries(id),
      leg_kind TEXT NOT NULL CHECK (leg_kind IN ('business_income', 'tax', 'mandatory_payment', 'business_expense', 'fx_sell', 'fx_buy', 'transfer_out', 'transfer_in', 'owner_draw', 'explicit_fee', 'terminal_personal_expense')),
      position INTEGER NOT NULL CHECK (position >= 0),
      UNIQUE(movement_group_id, ledger_entry_id)
    ) STRICT;

    CREATE TABLE movement_candidates (
      id TEXT PRIMARY KEY,
      debit_entry_id TEXT NOT NULL REFERENCES ledger_entries(id),
      credit_entry_id TEXT NOT NULL REFERENCES ledger_entries(id),
      match_kind TEXT NOT NULL CHECK (match_kind IN ('exact', 'near_amount', 'cross_currency')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'rejected')),
      reviewed_at TEXT,
      UNIQUE(debit_entry_id, credit_entry_id)
    ) STRICT;

    CREATE TABLE cost_components (
      id TEXT PRIMARY KEY,
      movement_group_id TEXT NOT NULL REFERENCES movement_groups(id),
      method TEXT NOT NULL CHECK (method IN ('explicit_statement_fee', 'same_currency_transfer_gap', 'fx_spread_estimate', 'manual_cost', 'unexplained_gap')),
      amount_minor INTEGER NOT NULL,
      currency TEXT NOT NULL,
      estimated INTEGER NOT NULL CHECK (estimated IN (0, 1)),
      audit_evidence_json TEXT NOT NULL DEFAULT '{}'
    ) STRICT;

    CREATE TABLE fx_conversions (
      id TEXT PRIMARY KEY,
      movement_group_id TEXT NOT NULL REFERENCES movement_groups(id),
      sold_amount_minor INTEGER NOT NULL CHECK (sold_amount_minor > 0),
      sold_currency TEXT NOT NULL,
      received_amount_minor INTEGER NOT NULL CHECK (received_amount_minor > 0),
      received_currency TEXT NOT NULL,
      executed_rate_text TEXT NOT NULL,
      benchmark_rate_text TEXT,
      benchmark_source TEXT,
      benchmark_publication_date TEXT,
      formula_version TEXT NOT NULL
    ) STRICT;

    CREATE TABLE categories (
      id TEXT PRIMARY KEY,
      parent_id TEXT REFERENCES categories(id),
      scope TEXT NOT NULL CHECK (scope IN ('business', 'personal')),
      code TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      editable INTEGER NOT NULL DEFAULT 1 CHECK (editable IN (0, 1))
    ) STRICT;

    CREATE TABLE category_assignments (
      id TEXT PRIMARY KEY,
      ledger_entry_id TEXT NOT NULL REFERENCES ledger_entries(id),
      category_id TEXT NOT NULL REFERENCES categories(id),
      method TEXT NOT NULL CHECK (method IN ('manual', 'user_rule', 'deterministic', 'merchant_heuristic', 'openai_codex', 'bank')),
      confidence_text TEXT,
      needs_review INTEGER NOT NULL DEFAULT 0 CHECK (needs_review IN (0, 1)),
      assigned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ) STRICT;

    CREATE TABLE categorization_rules (
      id TEXT PRIMARY KEY,
      priority INTEGER NOT NULL,
      match_json TEXT NOT NULL,
      category_id TEXT NOT NULL REFERENCES categories(id),
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
    ) STRICT;
  `,
} as const;

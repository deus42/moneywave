export const migration0012 = {
  version: 12,
  name: "canonical_taxonomy_v2",
  sql: `
    ALTER TABLE category_assignments RENAME TO category_assignments_v1;
    DROP INDEX category_assignments_entry_date;

    CREATE TABLE category_assignments (
      id TEXT PRIMARY KEY,
      ledger_entry_id TEXT NOT NULL REFERENCES ledger_entries(id),
      category_id TEXT NOT NULL REFERENCES categories(id),
      method TEXT NOT NULL CHECK (method IN ('manual', 'user_rule', 'alias', 'deterministic', 'mcc', 'merchant_heuristic', 'openai_codex', 'bank')),
      confidence_text TEXT,
      needs_review INTEGER NOT NULL DEFAULT 0 CHECK (needs_review IN (0, 1)),
      classification_version TEXT,
      evidence_json TEXT NOT NULL DEFAULT '{}',
      assigned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ) STRICT;
    CREATE INDEX category_assignments_entry_date
      ON category_assignments(ledger_entry_id, assigned_at DESC);

    INSERT INTO category_assignments (
      id, ledger_entry_id, category_id, method, confidence_text, needs_review, assigned_at
    )
    SELECT id, ledger_entry_id, category_id, method, confidence_text, needs_review, assigned_at
    FROM category_assignments_v1;

    DROP TABLE category_assignments_v1;

    INSERT INTO categories (id, parent_id, scope, code, display_name, editable) VALUES
      ('personal-insurance', NULL, 'personal', 'insurance', 'Страхування', 1),
      ('personal-government', NULL, 'personal', 'government_services', 'Державні послуги', 1),
      ('personal-pets', NULL, 'personal', 'pets', 'Домашні тварини', 1),
      ('personal-children', NULL, 'personal', 'children', 'Діти', 1),
      ('personal-professional', NULL, 'personal', 'professional_services', 'Професійні послуги', 1),
      ('personal-digital', 'personal-entertainment', 'personal', 'digital_services', 'Цифрові сервіси', 1);

    UPDATE categories SET display_name = 'Інші підтверджені витрати' WHERE code = 'other';
  `,
} as const;

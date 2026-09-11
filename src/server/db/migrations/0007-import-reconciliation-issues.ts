export const migration0007 = {
  version: 7,
  name: "import_reconciliation_issues",
  sql: `
    ALTER TABLE import_batches
      ADD COLUMN reconciliation_issues_json TEXT NOT NULL DEFAULT '[]'
      CHECK (json_valid(reconciliation_issues_json) AND json_type(reconciliation_issues_json) = 'array');
  `,
} as const;

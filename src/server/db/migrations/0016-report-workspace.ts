export const migration0016 = {
  version: 16,
  name: "report_workspace",
  sql: `
    CREATE TABLE workspace_reports (
      digest TEXT PRIMARY KEY CHECK(length(digest) = 64),
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ) STRICT;
    CREATE TABLE workspace_state (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      report_digest TEXT NOT NULL REFERENCES workspace_reports(digest),
      revision INTEGER NOT NULL CHECK(revision >= 0),
      payload_json TEXT NOT NULL
    ) STRICT;
    CREATE TABLE workspace_history (
      revision INTEGER PRIMARY KEY,
      action TEXT NOT NULL,
      before_json TEXT NOT NULL,
      after_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ) STRICT;
  `,
} as const;

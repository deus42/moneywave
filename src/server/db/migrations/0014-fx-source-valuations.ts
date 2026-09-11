export const migration0014 = {
  version: 14,
  name: "fx_source_valuations",
  sql: `
    CREATE TABLE fx_conversion_source_valuations (
      fx_conversion_id TEXT NOT NULL REFERENCES fx_conversions(id),
      source_currency TEXT NOT NULL CHECK (length(source_currency) BETWEEN 3 AND 8 AND source_currency = upper(source_currency)),
      target_currency TEXT NOT NULL CHECK (length(target_currency) BETWEEN 3 AND 8 AND target_currency = upper(target_currency)),
      converted_amount_minor INTEGER NOT NULL,
      requested_date TEXT NOT NULL CHECK (length(requested_date) = 10),
      rate_text TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('identity', 'ECB', 'NBU')),
      publication_date TEXT NOT NULL CHECK (length(publication_date) = 10),
      formula_version TEXT NOT NULL,
      valued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (fx_conversion_id, target_currency),
      CHECK ((source_currency = target_currency AND source = 'identity' AND rate_text = '1') OR source_currency <> target_currency)
    ) STRICT;
    CREATE INDEX fx_conversion_source_valuations_target_date
      ON fx_conversion_source_valuations(target_currency, requested_date);
  `,
} as const;

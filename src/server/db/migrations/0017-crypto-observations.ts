export const migration0017 = {
  version: 17,
  name: 'crypto_observations',
  sql: `CREATE TABLE crypto_observations (
    digest TEXT PRIMARY KEY CHECK(length(digest)=64),
    wallet_key TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    UNIQUE(wallet_key, observed_at)
  ) STRICT;`,
} as const;

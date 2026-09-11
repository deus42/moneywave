import type { EncryptedDatabase } from "../database";
import { migration0001 } from "./0001-foundation";
import { migration0002 } from "./0002-movements-costs";
import { migration0003 } from "./0003-audit-sync";
import { migration0004 } from "./0004-operational-read-model";
import { migration0005 } from "./0005-import-status-partition";
import { migration0006 } from "./0006-undated-observations";
import { migration0007 } from "./0007-import-reconciliation-issues";
import { migration0008 } from "./0008-movement-leg-ownership";
import { migration0009 } from "./0009-personal-taxonomy";
import { migration0010 } from "./0010-external-transfers";
import { migration0011 } from "./0011-monobank-valuations-cash";
import { migration0012 } from "./0012-canonical-taxonomy";
import { migration0013 } from "./0013-p2p-top-level";
import { migration0014 } from "./0014-fx-source-valuations";
import { migration0015 } from "./0015-manual-position-history";
import { migration0016 } from "./0016-report-workspace";
import { migration0017 } from "./0017-crypto-observations";

const MIGRATIONS = [migration0001, migration0002, migration0003, migration0004, migration0005, migration0006, migration0007, migration0008, migration0009, migration0010, migration0011, migration0012, migration0013, migration0014, migration0015, migration0016, migration0017] as const;

export const CURRENT_SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 0;
export const REQUIRED_TABLES = [
  "providers",
  "connections",
  "accounts",
  "account_instruments",
  "import_artifacts",
  "import_batches",
  "source_records",
  "ledger_entries",
  "transaction_evidence",
  "movement_groups",
  "movement_legs",
  "movement_candidates",
  "cost_components",
  "fx_conversions",
  "categories",
  "category_assignments",
  "categorization_rules",
  "balance_snapshots",
  "sync_cursors",
  "fx_rate_cache",
  "audit_events",
  "reconciliation_conflicts",
  "unresolved_observations",
  "provider_fee_evidence",
  "ledger_entry_valuations",
  "balance_snapshot_valuations",
  "cost_component_valuations",
  "fx_conversion_source_valuations",
  "category_aliases",
  "cash_opening_balances",
  "manual_workbooks",
  "manual_import_batches",
  "manual_position_series",
  "manual_position_facts",
  "manual_source_cells",
  "workspace_reports",
  "workspace_state",
  "workspace_history",
  "crypto_observations",
] as const;

export async function applyMigrations(database: EncryptedDatabase): Promise<{
  fromVersion: number;
  toVersion: number;
  applied: number[];
}> {
  const versionRow = await database.get<{ user_version: number }>("PRAGMA user_version");
  const fromVersion = versionRow?.user_version ?? 0;
  if (fromVersion > CURRENT_SCHEMA_VERSION) throw new Error("DB_SCHEMA_NEWER_THAN_APP");
  const applied: number[] = [];
  for (const migration of MIGRATIONS) {
    if (migration.version <= fromVersion) continue;
    await database.transaction(async () => {
      await database.exec(migration.sql);
      await database.run("INSERT INTO schema_migrations (version, name) VALUES (?, ?)", [migration.version, migration.name]);
      await database.exec(`PRAGMA user_version = ${migration.version}`);
    });
    applied.push(migration.version);
  }
  return { fromVersion, toVersion: CURRENT_SCHEMA_VERSION, applied };
}

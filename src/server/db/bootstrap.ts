import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";

import { createVerifiedBackup, type BackupManifest } from "./backup";
import { openEncryptedDatabase } from "./database";
import { applyMigrations, CURRENT_SCHEMA_VERSION } from "./migrations";

function safeTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

export async function initializeMoneyWaveDatabase(input: {
  databasePath: string;
  backupDirectory: string;
  key: Buffer;
}): Promise<{
  database: Awaited<ReturnType<typeof openEncryptedDatabase>>;
  migration: Awaited<ReturnType<typeof applyMigrations>>;
  preMigrationBackup: (BackupManifest & { path: string }) | null;
}> {
  const existing = await stat(input.databasePath).catch(() => null);
  const database = await openEncryptedDatabase(input.databasePath, input.key);
  try {
    const version = await database.get<{ user_version: number }>("PRAGMA user_version");
    const currentVersion = version?.user_version ?? 0;
    let preMigrationBackup: (BackupManifest & { path: string }) | null = null;
    if (existing?.isFile() && existing.size > 0 && currentVersion < CURRENT_SCHEMA_VERSION) {
      const tableRows = await database.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      );
      const backupPath = join(
        input.backupDirectory,
        `pre-migration-v${currentVersion}-${safeTimestamp(new Date())}-${randomUUID()}.backup`,
      );
      const manifest = await createVerifiedBackup({
        database,
        destinationPath: backupPath,
        key: input.key,
        reason: "before_migration",
        requiredTables: tableRows.map(({ name }) => name),
      });
      preMigrationBackup = { ...manifest, path: backupPath };
    }
    const migration = await applyMigrations(database);
    return { database, migration, preMigrationBackup };
  } catch (error) {
    await database.close().catch(() => undefined);
    throw error;
  }
}

import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import type { EncryptedDatabase } from "./database";
import { openEncryptedDatabase } from "./database";
import { REQUIRED_TABLES } from "./migrations";

export interface BackupManifest {
  sha256: string;
  sizeBytes: number;
  integrity: "ok";
  reason: "before_migration" | "after_import" | "manual" | "restore_safety";
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export async function verifyEncryptedBackup(
  path: string,
  key: Buffer,
  requiredTables: readonly string[] = REQUIRED_TABLES,
): Promise<{ sha256: string; sizeBytes: number; integrity: "ok" }> {
  const metadata = await stat(path).catch(() => null);
  if (!metadata || !metadata.isFile() || metadata.size <= 0) throw new Error("BACKUP_EMPTY_OR_MISSING");
  const restoreDirectory = await mkdtemp(join(tmpdir(), "moneywave-backup-verify-"));
  const restoredPath = join(restoreDirectory, "restore-check.db");
  try {
    await copyFile(path, restoredPath);
    await chmod(restoredPath, 0o600);
    let database: EncryptedDatabase;
    try {
      database = await openEncryptedDatabase(restoredPath, key);
    } catch {
      throw new Error("BACKUP_KEY_REJECTED");
    }
    try {
      const integrity = await database.get<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity?.integrity_check !== "ok") throw new Error("BACKUP_INTEGRITY_FAILED");
      const tables = await database.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'");
      const names = new Set(tables.map(({ name }) => name));
      if (!requiredTables.every((required) => names.has(required))) throw new Error("BACKUP_SCHEMA_INCOMPLETE");
    } finally {
      await database.close();
    }
    return { sha256: await sha256File(path), sizeBytes: metadata.size, integrity: "ok" };
  } finally {
    await rm(restoreDirectory, { recursive: true, force: true });
  }
}

export async function createVerifiedBackup(input: {
  database: EncryptedDatabase;
  destinationPath: string;
  key: Buffer;
  reason: BackupManifest["reason"];
  requiredTables?: readonly string[];
}): Promise<BackupManifest> {
  if (await pathExists(input.destinationPath)) throw new Error("BACKUP_DESTINATION_EXISTS");
  await mkdir(dirname(input.destinationPath), { recursive: true, mode: 0o700 });
  const keyHex = input.key.toString("hex");
  let attached = false;
  try {
    await input.database.run(`ATTACH DATABASE ? AS moneywave_backup KEY "x'${keyHex}'"`, [input.destinationPath]);
    attached = true;
    await input.database.get("SELECT sqlcipher_export('moneywave_backup') AS exported");
    const version = await input.database.get<{ user_version: number }>("PRAGMA user_version");
    await input.database.exec(`PRAGMA moneywave_backup.user_version = ${version?.user_version ?? 0}`);
    await input.database.exec("DETACH DATABASE moneywave_backup");
    attached = false;
    await chmod(input.destinationPath, 0o600);
    const verified = await verifyEncryptedBackup(input.destinationPath, input.key, input.requiredTables);
    return { ...verified, reason: input.reason };
  } catch (error) {
    if (attached) await input.database.exec("DETACH DATABASE moneywave_backup").catch(() => undefined);
    await rm(input.destinationPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function restoreVerifiedBackup(input: {
  backupPath: string;
  destinationPath: string;
  key: Buffer;
}): Promise<{ sha256: string; sizeBytes: number; integrity: "ok" }> {
  if (await pathExists(input.destinationPath)) throw new Error("RESTORE_DESTINATION_EXISTS");
  const verified = await verifyEncryptedBackup(input.backupPath, input.key);
  await mkdir(dirname(input.destinationPath), { recursive: true, mode: 0o700 });
  try {
    await copyFile(input.backupPath, input.destinationPath);
    await chmod(input.destinationPath, 0o600);
    await verifyEncryptedBackup(input.destinationPath, input.key);
    return verified;
  } catch (error) {
    await rm(input.destinationPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

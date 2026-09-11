import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { selectBackupsForRetention } from "@/server/db/backup-retention";
import { initializeMoneyWaveDatabase } from "@/server/db/bootstrap";
import { openEncryptedDatabase } from "@/server/db/database";
import { CURRENT_SCHEMA_VERSION } from "@/server/db/migrations";
import { migration0001 } from "@/server/db/migrations/0001-foundation";

describe("database bootstrap", () => {
  let directory: string;
  const key = Buffer.alloc(32, 41);

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "moneywave-bootstrap-test-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("initializes a new database without pretending an empty pre-migration backup exists", async () => {
    const result = await initializeMoneyWaveDatabase({
      databasePath: join(directory, "moneywave.db"),
      backupDirectory: join(directory, "backups"),
      key,
    });
    expect(result.migration).toMatchObject({ fromVersion: 0, toVersion: CURRENT_SCHEMA_VERSION });
    expect(result.preMigrationBackup).toBeNull();
    await result.database.close();
  });

  it("creates and verifies a backup before upgrading an existing schema", async () => {
    const databasePath = join(directory, "moneywave.db");
    const oldDatabase = await openEncryptedDatabase(databasePath, key);
    await oldDatabase.transaction(async () => {
      await oldDatabase.exec(migration0001.sql);
      await oldDatabase.run("INSERT INTO schema_migrations (version, name) VALUES (?, ?)", [migration0001.version, migration0001.name]);
      await oldDatabase.exec("PRAGMA user_version = 1");
    });
    await oldDatabase.close();

    const result = await initializeMoneyWaveDatabase({
      databasePath,
      backupDirectory: join(directory, "backups"),
      key,
    });
    expect(result.preMigrationBackup).toMatchObject({ reason: "before_migration", integrity: "ok" });
    expect(result.migration).toMatchObject({
      fromVersion: 1,
      toVersion: CURRENT_SCHEMA_VERSION,
      applied: Array.from({ length: CURRENT_SCHEMA_VERSION - 1 }, (_, index) => index + 2),
    });
    await expect(access(result.preMigrationBackup!.path)).resolves.toBeUndefined();
    await result.database.close();
  });
});

describe("backup retention selection", () => {
  it("keeps the latest 20 plus one latest backup per month across twelve calendar months", () => {
    const recent = Array.from({ length: 22 }, (_, index) => ({
      path: `/synthetic/recent-${index}.backup`,
      createdAt: new Date(Date.UTC(2099, 11, 31, 23, 59 - index)),
    }));
    const monthly = Array.from({ length: 13 }, (_, index) => ({
      path: `/synthetic/month-${index}.backup`,
      createdAt: new Date(Date.UTC(2099, 11 - index, 1)),
    }));
    const result = selectBackupsForRetention([...recent, ...monthly], new Date(Date.UTC(2099, 11, 31)));

    expect(result.keep).toEqual(expect.arrayContaining(recent.slice(0, 20).map(({ path }) => path)));
    expect(result.keep).toContain("/synthetic/month-11.backup");
    expect(result.remove).toContain("/synthetic/month-12.backup");
    expect(new Set([...result.keep, ...result.remove]).size).toBe(recent.length + monthly.length);
  });
});

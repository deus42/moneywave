import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openEncryptedDatabase, type EncryptedDatabase } from "@/server/db/database";
import { applyMigrations } from "@/server/db/migrations";
import { createVerifiedBackup } from "@/server/db/backup";
import { bankState, PositionWorkbookImport } from "@/server/manual/position-import";
import { syntheticManualWorkbook } from "../helpers/manual-workbook";

describe("encrypted manual position import (synthetic)", () => {
  let directory: string;
  let database: EncryptedDatabase;
  let importer: PositionWorkbookImport;
  let backups: number;
  const key = Buffer.alloc(32, 43);
  const input = () => ({ bytes: syntheticManualWorkbook(), lineageId: "synthetic-workbook", bindings: new Map([['erste:EUR', null], ['revolut:EUR', null], ['wise:EUR', null], ['zen:EUR', null], ['cash:EUR', 'cash-eur']]) });
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "moneywave-manual-test-"));
    database = await openEncryptedDatabase(join(directory, "synthetic.db"), key);
    await applyMigrations(database);
    await database.run("INSERT INTO providers VALUES ('cash','cash','Cash')");
    await database.run("INSERT INTO accounts (id,provider_id,owner_scope,account_type,currency,display_name) VALUES ('cash-eur','cash','PERSONAL','cash','EUR','Synthetic cash')");
    backups = 0;
    importer = new PositionWorkbookImport(database, key, async (reason) => createVerifiedBackup({ database, key,
      destinationPath: join(directory, `backup-${++backups}.backup`), reason }), () => new Date("2100-01-01"));
  });
  afterEach(async () => { await database?.close(); if (directory) await rm(directory, { recursive: true, force: true }); });
  it("persists encrypted artifact and exhaustive cells, not transactions or another cash account", async () => {
    const result = await importer.commit(input());
    expect(result).toMatchObject({ duplicate: false, factsCreated: 9, conflicts: 0, backupStatus: "verified" });
    expect(backups).toBe(2);
    expect(await database.get("SELECT COUNT(*) AS count FROM ledger_entries")).toEqual({ count: 0 });
    expect(await database.get("SELECT COUNT(*) AS count FROM accounts")).toEqual({ count: 1 });
    expect(await database.get("SELECT COUNT(*) AS count FROM manual_position_series WHERE account_id = 'cash-eur'")).toEqual({ count: 1 });
    const artifact = await database.get<{ bytes: Buffer }>("SELECT encrypted_bytes AS bytes FROM import_artifacts");
    expect(artifact?.bytes.equals(input().bytes)).toBe(true);
    expect(await database.get("SELECT COUNT(*) AS count FROM manual_source_cells WHERE disposition IS NULL")).toEqual({ count: 0 });
  });
  it("repeated bytes are idempotent and shifted coordinates only add provenance", async () => {
    await importer.commit(input());
    expect((await importer.commit(input())).duplicate).toBe(true);
    const changed = input();
    changed.bytes = syntheticManualWorkbook({ rows: [[0, "Synthetic note"], [1, "January 2099", 101.25, 202, 0, null, 40], [2, "February 2099", 111, 220, 30, 5, 60]] });
    expect(await importer.commit(changed)).toMatchObject({ factsCreated: 0, conflicts: 0 });
    expect(await database.get("SELECT COUNT(*) AS count FROM manual_position_facts")).toEqual({ count: 9 });
    expect(await database.get("SELECT COUNT(*) AS count FROM manual_source_cells WHERE fact_id IS NOT NULL")).toEqual({ count: 18 });
  });
  it("preserves both immutable values and marks a changed observation unresolved", async () => {
    await importer.commit(input());
    const changed = input();
    changed.bytes = syntheticManualWorkbook({ cells: { C2: { t: "n", v: 999, z: '[$€]0.00' } } });
    expect(await importer.commit(changed)).toMatchObject({ factsCreated: 1, conflicts: 1 });
    expect(await database.get("SELECT COUNT(*) AS count FROM manual_source_cells WHERE reason_code = 'SOURCE_VALUE_CONFLICT'")).toEqual({ count: 1 });
    expect(await database.get("SELECT COUNT(*) AS count FROM manual_position_facts")).toEqual({ count: 10 });
  });
  it("rejects a wrong-currency binding before backup or writes", async () => {
    await database.run("UPDATE accounts SET currency = 'USD' WHERE id = 'cash-eur'");
    await expect(importer.commit(input())).rejects.toThrow("MANUAL_ACCOUNT_BINDING_CONFLICT");
    expect(backups).toBe(0);
    expect(await database.get("SELECT COUNT(*) AS count FROM import_artifacts")).toEqual({ count: 0 });
  });
  it("stops before writes when verified backup is unavailable", async () => {
    const blocked = new PositionWorkbookImport(database, key, async () => { throw new Error("BACKUP_UNAVAILABLE"); });
    await expect(blocked.commit(input())).rejects.toThrow("BACKUP_UNAVAILABLE");
    expect(await database.get("SELECT COUNT(*) AS count FROM import_artifacts")).toEqual({ count: 0 });
  });
  it("rolls back source, series, facts and audit together", async () => {
    await database.exec("CREATE TRIGGER synthetic_fail BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'SYNTHETIC_FAILURE'); END");
    await expect(importer.commit(input())).rejects.toThrow("SYNTHETIC_FAILURE");
    for (const table of ["import_artifacts", "manual_workbooks", "manual_import_batches", "manual_source_cells", "manual_position_series", "manual_position_facts"]) {
      expect(await database.get(`SELECT COUNT(*) AS count FROM ${table}`)).toEqual({ count: 0 });
    }
  });
  it("does not count future monthly values as observed history", async () => {
    const result = await new PositionWorkbookImport(database, key, async (reason) => createVerifiedBackup({ database, key,
      destinationPath: join(directory, `backup-${++backups}.backup`), reason }), () => new Date("2099-01-15")).commit(input());
    expect(result.factsCreated).toBe(0);
    expect(await database.get("SELECT COUNT(*) AS count FROM manual_source_cells WHERE reason_code = 'PERIOD_NOT_COMPLETE'")).toEqual({ count: 9 });
  });
  it("cosmetic source-label changes do not create a second provider position", async () => {
    await importer.commit(input());
    const changed = input();
    changed.bytes = syntheticManualWorkbook({ cells: { C1: { t: "s", v: "Erste (XY)" } } });
    expect(await importer.commit(changed)).toMatchObject({ factsCreated: 0, conflicts: 0 });
    expect(await database.get("SELECT COUNT(*) AS count FROM manual_position_series")).toEqual({ count: 5 });
  });
  it("compares bank int64 values without rounding adjacent large integers together", async () => {
    await database.run("INSERT INTO balance_snapshots (id,account_id,balance_minor,currency,observed_at,evidence_kind) VALUES ('synthetic','cash-eur',CAST('9007199254740993' AS INTEGER),'EUR','2099-01-01','manual')");
    const before = await bankState(database);
    await database.run("UPDATE balance_snapshots SET balance_minor = CAST('9007199254740992' AS INTEGER) WHERE id = 'synthetic'");
    expect((await bankState(database)).digest).not.toBe(before.digest);
  });
  it("a failed post-import backup is retryable without duplicating source or facts", async () => {
    let attempt = 0;
    const retryable = new PositionWorkbookImport(database, key, async (reason) => {
      if (++attempt === 2) throw new Error("SYNTHETIC_BACKUP_FAILURE");
      return createVerifiedBackup({ database, key, destinationPath: join(directory, `retry-${attempt}.backup`), reason });
    }, () => new Date("2100-01-01"));
    expect(await retryable.commit(input())).toMatchObject({ backupStatus: "failed", factsCreated: 9 });
    expect(await retryable.commit(input())).toMatchObject({ backupStatus: "verified", duplicate: true, factsCreated: 0 });
    expect(await database.get("SELECT COUNT(*) AS count FROM manual_position_facts")).toEqual({ count: 9 });
  });
});

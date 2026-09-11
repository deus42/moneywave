import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { executeVerifiedAnalysis, executeVerifiedFinanceRun } from "@/server/analysis/verified-run";
import { openEncryptedDatabase, type EncryptedDatabase } from "@/server/db/database";
import { applyMigrations } from "@/server/db/migrations";

describe("verified autonomous analysis run", () => {
  let directory: string;
  let database: EncryptedDatabase;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "moneywave-verified-analysis-"));
    database = await openEncryptedDatabase(join(directory, "moneywave.db"), Buffer.alloc(32, 93));
    await applyMigrations(database);
  });

  afterEach(async () => {
    await database.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });

  it("backs up before mutation and verifies database integrity afterwards", async () => {
    const order: string[] = [];
    const result = await executeVerifiedAnalysis({
      database,
      createBackup: async () => { order.push("backup"); },
      analyze: async () => { order.push("analysis"); return { confirmed: 4 }; },
    });

    expect(order).toEqual(["backup", "analysis"]);
    expect(result).toEqual({ analysis: { confirmed: 4 }, integrity: "ok", foreignKeys: "ok" });
  });

  it("never starts analysis when backup creation fails", async () => {
    let analyzed = false;
    await expect(executeVerifiedAnalysis({
      database,
      createBackup: async () => { throw new Error("BACKUP_FAILED"); },
      analyze: async () => { analyzed = true; return {}; },
    })).rejects.toThrow("BACKUP_FAILED");
    expect(analyzed).toBe(false);
  });

  it("backs up before three ordered artifact imports and completes cash, analysis, and valuation", async () => {
    const order: string[] = [];
    const result = await executeVerifiedFinanceRun({
      database,
      artifacts: ["artifact-1", "artifact-2", "artifact-3"],
      createBackup: async () => { order.push("backup"); },
      importArtifact: async (artifact) => { order.push(`import:${artifact}`); return artifact === "artifact-2" ? "already_imported" : "imported"; },
      initializeCash: async () => { order.push("cash"); return { initialized: 3 }; },
      analyze: async () => { order.push("analysis"); return { pending: 0 }; },
      materializeValuations: async () => { order.push("valuations"); return { missing: 0 }; },
    });

    expect(order).toEqual([
      "backup",
      "import:artifact-1",
      "import:artifact-2",
      "import:artifact-3",
      "cash",
      "analysis",
      "valuations",
    ]);
    expect(result.analysis).toMatchObject({ importedArtifacts: 2, alreadyImportedArtifacts: 1 });
    expect(result).toMatchObject({ integrity: "ok", foreignKeys: "ok" });
  });
});

import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { createVerifiedBackup } from "../src/server/db/backup";
import { enforceBackupRetention } from "../src/server/db/backup-retention";
import { parsePositionWorkbook } from "../src/server/manual/position-workbook";
import { bankState, PositionWorkbookImport } from "../src/server/manual/position-import";
import { getDatabase, getSecretStore } from "../src/server/runtime/services";
import { resolveMoneyWavePaths } from "../src/server/runtime/paths";
import { deriveIdentifierHmacKey } from "../src/server/secrets/key-derivation";
import { monthEnd } from "../src/server/manual/position-workbook";
import type { EncryptedDatabase } from "../src/server/db/database";

async function run() {
  const args = process.argv.slice(2);
  const sourcePath = args.find((arg) => !arg.startsWith("--"));
  if (!sourcePath || args.some((arg) => arg.startsWith("--") && arg !== "--commit")) throw new Error("MANUAL_IMPORT_ARGUMENTS");
  const handle = await open(resolve(sourcePath), constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || !stat.size || stat.size > 25 * 1024 * 1024) throw new Error("MANUAL_SOURCE_INVALID");
    if (args.includes("--commit")) await handle.chmod(0o600);
    bytes = await handle.readFile();
    const after = await handle.stat();
    if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) { bytes.fill(0); throw new Error("MANUAL_SOURCE_CHANGED"); }
  } finally { await handle.close(); }
  try {
    const parsed = parsePositionWorkbook(bytes);
    const invalid = parsed.cells.filter((cell) => cell.disposition === "rejected" || (cell.disposition === "unresolved" && !["DOMAIN_DEFERRED", "NON_POSITION_INPUT"].includes(cell.reason ?? "")));
    if (invalid.length) {
      process.stdout.write(`manual_preview FAIL ${[...new Set(invalid.map((cell) => cell.reason))].join(",")}\n`);
      process.exitCode = 1; return;
    }
    if (!parsed.positions.length) throw new Error("MANUAL_POSITIONS_EMPTY");
    process.stdout.write("manual_preview PASS\n");
    if (!args.includes("--commit")) return;
    const key = await getSecretStore().get("database-key");
    const identifierKey = deriveIdentifierHmacKey(key);
    let database: EncryptedDatabase | undefined;
    try {
      database = await getDatabase(); // Bootstrap verifies backup before any pending migration.
      const before = await bankState(database);
      const bindings = new Map<string, string | null>();
      for (const position of parsed.positions) {
        const binding = `${position.provider}:${position.currency}`;
        if (bindings.has(binding)) continue;
        if (position.kind === "cash") {
          const accounts = await database.all<{ id: string }>("SELECT id FROM accounts WHERE account_type = 'cash' AND owner_scope = 'PERSONAL' AND currency = ?", [position.currency]);
          if (accounts.length !== 1) throw new Error("MANUAL_CASH_BINDING_AMBIGUOUS");
          bindings.set(binding, accounts[0].id);
        } else {
          // Provider names cannot prove an imported account's identity. The service
          // stops if a same-provider account exists instead of adding a second asset.
          bindings.set(binding, null);
        }
      }
      const paths = resolveMoneyWavePaths();
      const activeDatabase = database;
      const importer = new PositionWorkbookImport(database, identifierKey, async (reason) => createVerifiedBackup({
        database: activeDatabase, key, destinationPath: join(paths.backupDirectory, `manual-position-${randomUUID()}.backup`), reason,
      }));
      const result = await importer.commit({ bytes, lineageId: "personal-workbook", bindings });
      if (result.backupStatus !== "verified") throw new Error("MANUAL_POST_IMPORT_BACKUP_FAILED");
      const after = await bankState(database);
      if (before.digest !== after.digest) throw new Error("MANUAL_BANK_STATE_CHANGED");
      const artifact = await database.get<{ bytes: Buffer }>("SELECT artifact.encrypted_bytes AS bytes FROM import_artifacts artifact JOIN manual_import_batches batch ON batch.artifact_id = artifact.id WHERE batch.id = ?", [result.batchId]);
      if (!artifact || createHash("sha256").update(artifact.bytes).digest("hex") !== createHash("sha256").update(bytes).digest("hex")) throw new Error("MANUAL_ARTIFACT_READBACK_FAILED");
      artifact.bytes.fill(0);
      const cells = await database.get<{ count: number }>("SELECT COUNT(*) AS count FROM manual_source_cells WHERE batch_id = ?", [result.batchId]);
      if (cells?.count !== parsed.cells.length) throw new Error("MANUAL_CELL_COVERAGE_FAILED");
      const rows = await database.all<{ address: string; amount: string; period: string; currency: string }>(`
        SELECT cell.cell_address AS address, CAST(fact.amount_minor AS TEXT) AS amount, fact.period, series.currency
        FROM manual_source_cells cell JOIN manual_position_facts fact ON fact.id = cell.fact_id
        JOIN manual_position_series series ON series.id = fact.series_id WHERE cell.batch_id = ?`, [result.batchId]);
      const expected = parsed.positions.filter((position) => monthEnd(position.period) <= new Date().toISOString().slice(0, 10));
      if (rows.length !== expected.length) throw new Error("MANUAL_FACT_COVERAGE_FAILED");
      if (rows.some((row) => !parsed.positions.some((position) => position.address === row.address && position.period === row.period && position.currency === row.currency && position.amountMinor === row.amount))) throw new Error("MANUAL_FACT_READBACK_FAILED");
      if ((await database.get<{ integrity_check: string }>("PRAGMA integrity_check"))?.integrity_check !== "ok" || (await database.all("PRAGMA foreign_key_check")).length) throw new Error("MANUAL_INTEGRITY_FAILED");
      await enforceBackupRetention(paths.backupDirectory);
      process.stdout.write(result.duplicate ? "manual_import PASS ALREADY_IMPORTED\n" : "manual_import PASS\n");
      process.stdout.write("manual_readback PASS\n");
    } finally { identifierKey.fill(0); key.fill(0); await database?.close(); }
  } finally { bytes.fill(0); }
}

run().catch((error: unknown) => {
  const code = error instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/u.test(error.message) ? error.message : "MANUAL_IMPORT_FAILED";
  process.stdout.write(`manual_import FAIL ${code}\n`);
  process.exitCode = 1;
});

import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CashService } from "../src/server/cash/service";
import { createVerifiedBackup, restoreVerifiedBackup } from "../src/server/db/backup";
import { openEncryptedDatabase, type EncryptedDatabase } from "../src/server/db/database";
import { HistoricalRateBook, type ResolvedHistoricalRate } from "../src/server/fx/historical-rates";
import { ValuationService } from "../src/server/fx/valuation-service";
import { resolveMoneyWavePaths } from "../src/server/runtime/paths";
import { getSecretStore } from "../src/server/runtime/services";

interface RepairRow { bankId: string; cashId: string; oldCurrency: string; sourceCurrency: string }

async function mismatches(database: EncryptedDatabase): Promise<RepairRow[]> {
  return database.all<RepairRow>(`
    SELECT DISTINCT bank.id AS bankId, cash.id AS cashId, cash.currency AS oldCurrency, te.source_currency AS sourceCurrency
    FROM ledger_entries bank JOIN accounts ba ON ba.id=bank.account_id
    JOIN transaction_evidence te ON te.ledger_entry_id=bank.id
    JOIN movement_legs bl ON bl.ledger_entry_id=bank.id JOIN movement_groups g ON g.id=bl.movement_group_id
    JOIN movement_legs cl ON cl.movement_group_id=g.id JOIN ledger_entries cash ON cash.id=cl.ledger_entry_id
    JOIN accounts ca ON ca.id=cash.account_id
    WHERE ba.account_type<>'cash' AND ca.account_type='cash'
      AND g.evidence_kind IN ('cash_mcc','cash_withdrawal_description','cash_deposit_description')
      AND te.source_currency IS NOT NULL AND te.source_amount_minor IS NOT NULL
      AND (cash.currency<>te.source_currency OR abs(cash.amount_minor)<>abs(te.source_amount_minor))
    ORDER BY bank.id, cash.id
  `);
}

// Hash all rows outside the exact generated repair scope, including raw imports and workspace history.
async function preservedState(database: EncryptedDatabase, cashIds: string[], snapshotIds: string[]) {
  const tables = await database.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  const state: Record<string, { count: number; hash: string }> = {};
  for (const { name } of tables) {
    if (!/^[a-z_]+$/u.test(name)) throw new Error("CASH_REPAIR_TABLE_INVALID");
    let clause = "", values: string[] = [];
    if (name === "ledger_entries" || name === "ledger_entry_valuations") {
      clause = ` WHERE ${name === "ledger_entries" ? "id" : "ledger_entry_id"} NOT IN (SELECT value FROM json_each(?))`;
      values = [JSON.stringify(cashIds)];
    } else if (name === "balance_snapshots" || name === "balance_snapshot_valuations") {
      clause = ` WHERE ${name === "balance_snapshots" ? "id" : "balance_snapshot_id"} NOT IN (SELECT value FROM json_each(?))`;
      values = [JSON.stringify(snapshotIds)];
    } else if (name === "audit_events") {
      clause = " WHERE event_code<>'CASH_SOURCE_AMOUNT_CORRECTED'";
    }
    const rows = await database.all(`SELECT * FROM "${name}"${clause} ORDER BY rowid`, values);
    state[name] = { count: rows.length, hash: createHash("sha256").update(JSON.stringify(rows)).digest("hex") };
  }
  return state;
}

async function main(): Promise<void> {
  const commit = process.argv.includes("--commit");
  if (process.argv.slice(2).some(arg => arg !== "--commit")) throw new Error("CASH_REPAIR_ARGUMENT_INVALID");
  const paths = resolveMoneyWavePaths();
  if ((await stat(paths.databasePath)).size <= 0) throw new Error("DATABASE_MISSING");
  const key = await getSecretStore().get("database-key");
  const database = await openEncryptedDatabase(paths.databasePath, key).catch(error => { key.fill(0); throw error; });
  try {
    if (!commit) await database.exec("PRAGMA query_only=ON");
    const rows = await mismatches(database);
    console.log(`CASH_REPAIR_PREVIEW mismatches=${rows.length}`);
    if (!commit || rows.length === 0) return;
    const cashIds = [...new Set(rows.map(r => r.cashId))];
    const currencies = [...new Set(rows.flatMap(r => [r.oldCurrency, r.sourceCurrency]))];
    const snapshotIds = currencies.map(currency => `cash-derived-snapshot-${currency.toLowerCase()}`);
    const before = await preservedState(database, cashIds, snapshotIds);
    const countBefore = await database.get("SELECT (SELECT COUNT(*) FROM ledger_entries) AS entries, (SELECT COUNT(*) FROM movement_groups) AS groups, (SELECT COUNT(*) FROM balance_snapshots) AS snapshots");
    // Reuse only dated official evidence already present locally; no network or inferred exchange rate.
    const rates = await database.all<{ base: string; quote: string; day: string } & ResolvedHistoricalRate>(`
      SELECT base_currency AS base, quote_currency AS quote, requested_date AS day, rate_text AS rate, source, publication_date AS publicationDate FROM fx_rate_cache
      UNION SELECT source_currency,target_currency,requested_date,rate_text,source,publication_date FROM ledger_entry_valuations
      UNION SELECT source_currency,target_currency,requested_date,rate_text,source,publication_date FROM balance_snapshot_valuations
      ORDER BY day, base, quote, source
    `);
    const cached = new Map(rates.map(rate => [`${rate.base}:${rate.quote}:${rate.day}`, rate]));
    const resolver = { resolve(base: string, quote: string, day: string): ResolvedHistoricalRate | null {
      if (base === quote) return { rate: "1", source: "identity", publicationDate: day };
      const direct = cached.get(`${base}:${quote}:${day}`);
      if (direct) return direct;
      const book = new HistoricalRateBook(rates.flatMap(rate => rate.day === day && rate.base !== rate.quote && rate.source !== "identity"
        ? [{ base: rate.base, quote: rate.quote, rate: rate.rate, source: rate.source, publicationDate: rate.publicationDate }]
        : []));
      return book.resolve(base, quote, day);
    } };
    const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
    const backupPath = join(paths.backupDirectory, `before-cash-source-repair-${stamp}-${randomUUID()}.backup`);
    const manifest = await createVerifiedBackup({ database, destinationPath: backupPath, key, reason: "manual", requiredTables: Object.keys(before) });
    console.log("CASH_REPAIR_BACKUP_VERIFIED");
    // Prove the exact repair and cached-rate coverage on a restored encrypted copy before touching live records.
    const rehearsalDirectory = await mkdtemp(join(paths.dataRoot, "cash-repair-rehearsal-"));
    try {
      const rehearsalPath = join(rehearsalDirectory, "moneywave.db");
      await restoreVerifiedBackup({ backupPath, destinationPath: rehearsalPath, key });
      const rehearsal = await openEncryptedDatabase(rehearsalPath, key);
      try {
        await new CashService(rehearsal).repairDerivedMovements(rows.map(row => row.bankId));
        const previewValued = await new ValuationService(rehearsal, resolver).materialize({
          fromDate: "0001-01-01", toDate: "9999-12-31", scope: { ledgerEntryIds: cashIds, balanceSnapshotIds: snapshotIds },
        });
        if (previewValued.missingRates.length) throw new Error("CASH_REPAIR_VALUATIONS_INCOMPLETE");
        if ((await mismatches(rehearsal)).length) throw new Error("CASH_REPAIR_READBACK_MISMATCH");
        if (JSON.stringify(before) !== JSON.stringify(await preservedState(rehearsal, cashIds, snapshotIds))) {
          throw new Error("CASH_REPAIR_UNRELATED_STATE_CHANGED");
        }
      } finally { await rehearsal.close(); }
    } finally { await rm(rehearsalDirectory, { recursive: true, force: true }); }
    console.log("CASH_REPAIR_REHEARSAL_VERIFIED");
    const service = new CashService(database);
    const corrected = await service.repairDerivedMovements(rows.map(row => row.bankId));
    const valued = await new ValuationService(database, resolver).materialize({
      fromDate: "0001-01-01", toDate: "9999-12-31", scope: { ledgerEntryIds: cashIds, balanceSnapshotIds: snapshotIds },
    });
    const after = await preservedState(database, cashIds, snapshotIds);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("CASH_REPAIR_UNRELATED_STATE_CHANGED");
    if ((await mismatches(database)).length !== 0) throw new Error("CASH_REPAIR_READBACK_MISMATCH");
    const repeated = await service.repairDerivedMovements(rows.map(row => row.bankId));
    if (repeated.movementsCorrected !== 0) throw new Error("CASH_REPAIR_NOT_IDEMPOTENT");
    if ((await database.all("PRAGMA foreign_key_check")).length !== 0) throw new Error("CASH_REPAIR_FOREIGN_KEYS_FAILED");
    if ((await database.get<{ integrity_check: string }>("PRAGMA integrity_check"))?.integrity_check !== "ok") throw new Error("CASH_REPAIR_INTEGRITY_FAILED");
    const countAfter = await database.get("SELECT (SELECT COUNT(*) FROM ledger_entries) AS entries, (SELECT COUNT(*) FROM movement_groups) AS groups, (SELECT COUNT(*) FROM balance_snapshots) AS snapshots");
    const output = join(paths.dataRoot, "cash-source-repair", `${stamp}.json`);
    await mkdir(join(paths.dataRoot, "cash-source-repair"), { recursive: true, mode: 0o700 });
    await writeFile(output, JSON.stringify({ backupPath, manifest, corrected, valued, countBefore, countAfter, preserved: before, sourceReadback: "exact", idempotent: true }, null, 2), { mode: 0o600 });
    if (valued.missingRates.length > 0) throw new Error("CASH_REPAIR_VALUATIONS_INCOMPLETE");
    console.log(`CASH_REPAIR_COMPLETE corrected=${corrected.movementsCorrected} missing_rates=0 preserved_tables=${Object.keys(before).length}`);
  } finally {
    key.fill(0);
    await database.close();
  }
}

main().catch(error => {
  console.error(error instanceof Error && /^[A-Z][A-Z0-9_]+$/u.test(error.message) ? error.message : "CASH_REPAIR_FAILED");
  process.exitCode = 1;
});

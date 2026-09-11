import { createHash, createHmac, randomUUID } from "node:crypto";
import type { EncryptedDatabase } from "@/server/db/database";
import type { BackupManifest } from "@/server/db/backup";
import { monthEnd, parsePositionWorkbook, POSITION_PARSER_VERSION, type ParsedPosition } from "./position-workbook";

type Backup = (reason: "manual" | "after_import") => Promise<BackupManifest>;
export interface PositionImportInput {
  bytes: Buffer;
  lineageId: string;
  /** Explicit local source binding. Null is a distinct manual bank position. */
  bindings: ReadonlyMap<string, string | null>;
}
export interface PositionImportResult {
  batchId: string;
  duplicate: boolean;
  factsCreated: number;
  conflicts: number;
  backupStatus: "verified" | "failed";
}

const BANK_TABLES = ["accounts", "account_instruments", "ledger_entries", "transaction_evidence", "balance_snapshots",
  "movement_groups", "movement_legs", "cost_components", "category_assignments", "cash_opening_balances"] as const;

/** Used internally for exact preservation checks; never print hashes or row payloads. */
export async function bankState(database: EncryptedDatabase) {
  const counts: Record<string, number> = {};
  const digest = createHash("sha256");
  for (const table of BANK_TABLES) {
    const columns = await database.all<{ name: string }>(`PRAGMA table_info(${table})`);
    if (columns.some(({ name }) => !/^[a-z_]+$/u.test(name))) throw new Error("MANUAL_BANK_SCHEMA_UNSUPPORTED");
    // SQL quote() preserves int64 digits before the binding can convert to Number.
    const rows = await database.all(`SELECT ${columns.map(({ name }) => `quote(${name}) AS ${name}`).join(",")} FROM ${table} ORDER BY rowid`);
    counts[table] = rows.length;
    digest.update(table).update(JSON.stringify(rows));
  }
  return { counts, digest: digest.digest("hex") };
}

export class PositionWorkbookImport {
  constructor(private readonly database: EncryptedDatabase, private readonly identifierKey: Buffer,
    private readonly backup: Backup, private readonly now = () => new Date()) {
    if (identifierKey.length !== 32) throw new Error("MANUAL_IDENTIFIER_KEY_INVALID");
  }

  async commit(input: PositionImportInput): Promise<PositionImportResult> {
    if (!/^[a-z0-9-]{1,80}$/u.test(input.lineageId)) throw new Error("MANUAL_LINEAGE_INVALID");
    const parsed = parsePositionWorkbook(input.bytes);
    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    const repeated = await this.database.get<{ id: string; lineage: string; backup: string }>(`
      SELECT batch.id, batch.lineage_id AS lineage, batch.backup_status AS backup FROM manual_import_batches batch
      JOIN import_artifacts artifact ON artifact.id = batch.artifact_id WHERE artifact.sha256 = ?`, [sha256]);
    if (repeated) {
      if (repeated.lineage !== input.lineageId) throw new Error("MANUAL_ARTIFACT_LINEAGE_CONFLICT");
      const backupStatus = repeated.backup === "verified" ? "verified" : await this.finishBackup(repeated.id);
      return { batchId: repeated.id, duplicate: true, factsCreated: 0, conflicts: 0, backupStatus };
    }
    const seriesKeys = new Map<string, ParsedPosition>();
    for (const position of parsed.positions) seriesKeys.set(`${position.provider}:${position.currency}`, position);
    for (const [binding, position] of seriesKeys) {
      if (!input.bindings.has(binding)) throw new Error("MANUAL_BINDING_MISSING");
      const accountId = input.bindings.get(binding);
      if (accountId) {
        const account = await this.database.get<{ currency: string; type: string; provider: string; scope: string }>(`
          SELECT account.currency, account.account_type AS type, provider.code AS provider, account.owner_scope AS scope
          FROM accounts account JOIN providers provider ON provider.id = account.provider_id WHERE account.id = ?`, [accountId]);
        if (!account || account.currency !== position.currency || account.scope !== "PERSONAL"
          || (position.kind === "cash" ? account.type !== "cash" : account.provider !== position.provider || account.type === "cash")) {
          throw new Error("MANUAL_ACCOUNT_BINDING_CONFLICT");
        }
      } else {
        const possible = await this.database.get<{ count: number }>(`
          SELECT COUNT(*) AS count FROM accounts account JOIN providers provider ON provider.id = account.provider_id
          WHERE account.currency = ? AND (provider.code = ? OR (? = 'cash' AND account.account_type = 'cash'))`, [position.currency, position.provider, position.kind]);
        if (position.kind === "cash" || possible?.count) throw new Error("MANUAL_EXISTING_ACCOUNT_REQUIRES_BINDING");
      }
    }
    const before = await bankState(this.database);
    const backup = await this.backup("manual");
    this.requireBackup(backup);
    const batchId = randomUUID();
    let factsCreated = 0;
    let conflicts = 0;
    await this.database.transaction(async () => {
      await this.database.run("INSERT OR IGNORE INTO manual_workbooks (id,contract_version) VALUES (?,?)", [input.lineageId, POSITION_PARSER_VERSION]);
      const artifactId = randomUUID();
      await this.database.run("INSERT INTO import_artifacts (id,sha256,encrypted_bytes,size_bytes,parser_kind,parser_version) VALUES (?,?,?,?,'manual_positions',?)", [artifactId, sha256, input.bytes, input.bytes.length, POSITION_PARSER_VERSION]);
      await this.database.run("INSERT INTO manual_import_batches (id,lineage_id,artifact_id,cell_count,backup_status) VALUES (?,?,?,?,'pending')", [batchId, input.lineageId, artifactId, parsed.cells.length]);
      const byAddress = new Map(parsed.positions.map((p) => [p.address, p]));
      for (const cell of parsed.cells) {
        const position = cell.sheet === "Savings" ? byAddress.get(cell.address) : undefined;
        let disposition = cell.disposition;
        let reason = cell.reason;
        let factId: string | null = null;
        if (position && monthEnd(position.period) > this.now().toISOString().slice(0, 10)) {
          disposition = "unresolved"; reason = "PERIOD_NOT_COMPLETE";
        } else if (position) {
          // The closed format has exactly one column per provider. Its slot is
          // stable across cosmetic label/region changes and moved rows.
          const labelKey = createHmac("sha256", this.identifierKey).update(`moneywave:manual-position:v1:${position.provider}`).digest("hex");
          const accountId = input.bindings.get(`${position.provider}:${position.currency}`) ?? null;
          let series = await this.database.get<{ id: string; account: string | null }>("SELECT id, account_id AS account FROM manual_position_series WHERE lineage_id = ? AND label_key = ? AND currency = ?", [input.lineageId, labelKey, position.currency]);
          if (series && series.account !== accountId) throw new Error("MANUAL_SERIES_BINDING_CHANGED");
          if (!series) {
            series = { id: randomUUID(), account: accountId };
            await this.database.run("INSERT INTO manual_position_series (id,lineage_id,label_key,display_name,provider_code,position_kind,currency,account_id) VALUES (?,?,?,?,?,?,?,?)", [series.id, input.lineageId, labelKey, position.label, position.provider, position.kind, position.currency, accountId]);
          }
          const facts = await this.database.all<{ id: string; amount: string }>("SELECT id, CAST(amount_minor AS TEXT) AS amount FROM manual_position_facts WHERE series_id = ? AND period = ?", [series.id, position.period]);
          const same = facts.find((fact) => fact.amount === position.amountMinor);
          factId = same?.id ?? randomUUID();
          if (!same) {
            await this.database.run("INSERT INTO manual_position_facts (id,series_id,period,amount_minor) VALUES (?,?,?,CAST(? AS INTEGER))", [factId, series.id, position.period, position.amountMinor]);
            factsCreated++;
          }
          if (facts.some((fact) => fact.amount !== position.amountMinor)) {
            disposition = "unresolved"; reason = "SOURCE_VALUE_CONFLICT"; conflicts++;
          } else disposition = accountId ? "linked_to_ledger" : "manual_fact";
        }
        await this.database.run("INSERT INTO manual_source_cells (id,batch_id,sheet_name,cell_address,disposition,reason_code,fact_id) VALUES (?,?,?,?,?,?,?)", [randomUUID(), batchId, cell.sheet, cell.address, disposition, reason, factId]);
      }
      const covered = await this.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM manual_source_cells WHERE batch_id = ?", [batchId]);
      if (covered?.count !== parsed.cells.length) throw new Error("MANUAL_CELL_COVERAGE_FAILED");
      const after = await bankState(this.database);
      if (before.digest !== after.digest) throw new Error("MANUAL_BANK_STATE_CHANGED");
      await this.database.run("UPDATE manual_import_batches SET audit_counts_json = ? WHERE id = ?", [JSON.stringify({ before: before.counts, after: after.counts, factsCreated, conflicts }), batchId]);
      await this.database.run("INSERT INTO audit_events (id,event_code,entity_type,entity_id,safe_details_json) VALUES (?,'MANUAL_POSITIONS_IMPORTED','manual_import_batch',?,?)", [randomUUID(), batchId, JSON.stringify({ cellCount: covered.count, factsCreated, conflicts })]);
    });
    return { batchId, duplicate: false, factsCreated, conflicts, backupStatus: await this.finishBackup(batchId) };
  }

  private requireBackup(manifest: BackupManifest) {
    if (manifest.integrity !== "ok" || manifest.sizeBytes <= 0 || !/^[a-f0-9]{64}$/u.test(manifest.sha256)) throw new Error("MANUAL_BACKUP_UNVERIFIED");
  }

  private async finishBackup(batchId: string): Promise<"verified" | "failed"> {
    let status: "verified" | "failed" = "verified";
    try { this.requireBackup(await this.backup("after_import")); } catch { status = "failed"; }
    await this.database.run("UPDATE manual_import_batches SET backup_status = ? WHERE id = ?", [status, batchId]);
    return status;
  }
}

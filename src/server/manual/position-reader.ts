import type { EncryptedDatabase } from "@/server/db/database";
import { monthEnd } from "./position-workbook";

export interface ManualPositionEvidence {
  seriesId: string;
  accountId: string | null;
  name: string;
  provider: string;
  kind: "bank" | "cash";
  currency: string;
  period: string;
  amountMinor: string | null;
  conflicting: boolean;
  sources: Array<{ sheet: string; address: string }>;
  comparison: "no_bank_statement" | "month_precision" | "older_evidence" | "cash_record_gap";
  differenceMinor: string | null;
}

export async function latestManualPositions(database: EncryptedDatabase, asOf: string): Promise<ManualPositionEvidence[]> {
  const rows = await database.all<{
    id: string; seriesId: string; accountId: string | null; name: string; provider: string;
    kind: "bank" | "cash"; currency: string; period: string; amountMinor: string;
  }>(`SELECT fact.id, series.id AS seriesId, series.account_id AS accountId, series.display_name AS name,
      series.provider_code AS provider, series.position_kind AS kind, series.currency, fact.period,
      CAST(fact.amount_minor AS TEXT) AS amountMinor
    FROM manual_position_facts fact JOIN manual_position_series series ON series.id = fact.series_id
    WHERE fact.period <= ? ORDER BY fact.period DESC, series.id, fact.id`, [asOf.slice(0, 7)]);
  const grouped = new Map<string, typeof rows>();
  for (const row of rows) {
    if (monthEnd(row.period) > asOf) continue;
    const key = row.accountId ? `account:${row.accountId}` : `manual:${row.seriesId}`;
    const group = grouped.get(key) ?? [];
    if (!group.length || group[0].period === row.period) group.push(row);
    grouped.set(key, group);
  }
  const result: ManualPositionEvidence[] = [];
  for (const facts of grouped.values()) {
    const first = facts[0];
    const conflicting = facts.some((f) => f.amountMinor !== first.amountMinor || f.currency !== first.currency);
    const sources = await database.all<{ sheet: string; address: string }>(`
      SELECT DISTINCT cell.sheet_name AS sheet, cell.cell_address AS address FROM manual_source_cells cell
      WHERE cell.fact_id IN (${facts.map(() => "?").join(",")}) ORDER BY sheet, address LIMIT 5`, facts.map((fact) => fact.id));
    result.push({ ...first, conflicting, amountMinor: conflicting ? null : first.amountMinor, sources,
      comparison: "no_bank_statement", differenceMinor: null });
  }
  return result;
}

export async function manualImportCoverage(database: EncryptedDatabase) {
  const batches = await database.all<{ id: string; cellCount: number; backupStatus: string; importedAt: string }>(`
    SELECT id, cell_count AS cellCount, backup_status AS backupStatus, imported_at AS importedAt
    FROM manual_import_batches ORDER BY imported_at DESC, rowid DESC`);
  const coverage = await database.all<{ sheet: string; disposition: string; reason: string | null; count: number }>(`
    SELECT sheet_name AS sheet, disposition, reason_code AS reason, COUNT(*) AS count
    FROM manual_source_cells WHERE batch_id = ? GROUP BY sheet_name, disposition, reason_code
    ORDER BY sheet_name, disposition, reason_code`, [batches[0]?.id ?? ""]);
  const history = await database.get<{ series: number; observations: number }>(`
    SELECT (SELECT COUNT(*) FROM manual_position_series) AS series,
      (SELECT COUNT(*) FROM manual_position_facts) AS observations`);
  return { batches, coverage, series: history?.series ?? 0, observations: history?.observations ?? 0 };
}

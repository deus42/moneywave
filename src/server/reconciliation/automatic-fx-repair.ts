import { randomUUID } from "node:crypto";

import Decimal from "decimal.js";

import type { EncryptedDatabase } from "@/server/db/database";

interface AutomaticFxRow {
  groupId: string;
  executedRate: string;
  benchmarkRate: string;
  debitEntryId: string;
  creditEntryId: string;
}

function isPlausible(executedRate: string, benchmarkRate: string): boolean {
  try {
    const executed = new Decimal(executedRate);
    const benchmark = new Decimal(benchmarkRate);
    if (!executed.isFinite() || !benchmark.isFinite() || executed.lte(0) || benchmark.lte(0)) return false;
    return executed.sub(benchmark).abs().div(benchmark).lte(0.1);
  } catch {
    return false;
  }
}

export class AutomaticFxRepairService {
  readonly #database: EncryptedDatabase;

  constructor(database: EncryptedDatabase) {
    this.#database = database;
  }

  async run(): Promise<{ checked: number; revoked: number; retained: number }> {
    const rows = await this.#database.all<AutomaticFxRow>(`
      SELECT
        movement.id AS groupId,
        conversion.executed_rate_text AS executedRate,
        conversion.benchmark_rate_text AS benchmarkRate,
        debit.ledger_entry_id AS debitEntryId,
        credit.ledger_entry_id AS creditEntryId
      FROM movement_groups movement
      JOIN fx_conversions conversion ON conversion.movement_group_id = movement.id
      JOIN movement_legs debit ON debit.movement_group_id = movement.id
      JOIN ledger_entries debit_entry ON debit_entry.id = debit.ledger_entry_id AND debit_entry.direction = 'debit'
      JOIN movement_legs credit ON credit.movement_group_id = movement.id
      JOIN ledger_entries credit_entry ON credit_entry.id = credit.ledger_entry_id AND credit_entry.direction = 'credit'
      WHERE movement.evidence_kind = 'automatic_fx'
        AND conversion.benchmark_rate_text IS NOT NULL
      ORDER BY movement.id
    `);
    const invalid = rows.filter((row) => !isPlausible(row.executedRate, row.benchmarkRate));
    if (invalid.length === 0) return { checked: rows.length, revoked: 0, retained: rows.length };

    await this.#database.transaction(async () => {
      for (const row of invalid) {
        const entryIds = [row.debitEntryId, row.creditEntryId] as const;
        await this.#database.run(
          "DELETE FROM category_assignments WHERE ledger_entry_id IN (?, ?) AND method NOT IN ('manual', 'user_rule')",
          entryIds,
        );
        await this.#database.run("DELETE FROM cost_components WHERE movement_group_id = ?", [row.groupId]);
        await this.#database.run("DELETE FROM fx_conversions WHERE movement_group_id = ?", [row.groupId]);
        await this.#database.run("DELETE FROM movement_legs WHERE movement_group_id = ?", [row.groupId]);
        await this.#database.run(
          "UPDATE movement_candidates SET status = 'rejected', reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE debit_entry_id = ? AND credit_entry_id = ? AND status = 'confirmed'",
          entryIds,
        );
        await this.#database.run(
          "UPDATE ledger_entries SET entry_kind = 'unclassified', reconciliation_status = 'unlinked' WHERE id IN (?, ?)",
          entryIds,
        );
        await this.#database.run("DELETE FROM movement_groups WHERE id = ?", [row.groupId]);
        await this.#database.run(
          "INSERT INTO audit_events (id, event_code, entity_type, entity_id, safe_details_json) VALUES (?, 'AUTOMATIC_FX_OUTLIER_REVOKED', 'movement_group', ?, ?)",
          [randomUUID(), row.groupId, JSON.stringify({ reasonCode: "BENCHMARK_DEVIATION_OVER_10_PERCENT" })],
        );
      }
    });

    return { checked: rows.length, revoked: invalid.length, retained: rows.length - invalid.length };
  }
}

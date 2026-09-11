import { hasExternalAccountTransferSignal, hasFxSignal, hasMerchantFxPaymentSignal, hasMobileTopUpSignal, hasOwnTransferSignal } from "@/domain/transaction-signals";
import type { EncryptedDatabase } from "@/server/db/database";
import { categoryForMcc } from "./mcc";

interface LegacyRow {
  id: string;
  entryKind: string;
  description: string | null;
  sourceCategory: string | null;
}

export class ReclassificationPreparationService {
  readonly #database: EncryptedDatabase;

  constructor(database: EncryptedDatabase) {
    this.#database = database;
  }

  async run(): Promise<{ resetEntries: number; removedAutomaticAssignments: number }> {
    const rows = await this.#database.all<LegacyRow>(`
      SELECT
        le.id,
        le.entry_kind AS entryKind,
        le.private_description AS description,
        (
          SELECT COALESCE(json_extract(sr.source_metadata_json, '$.sourceCategory'), json_extract(sr.source_metadata_json, '$.statementCategory'))
          FROM transaction_evidence te
          JOIN source_records sr ON sr.id = te.source_record_id
          WHERE te.ledger_entry_id = le.id
          ORDER BY te.rowid
          LIMIT 1
        ) AS sourceCategory
      FROM ledger_entries le
      WHERE le.entry_kind IN (
        'business_income', 'business_expense', 'terminal_personal_expense', 'personal_income',
        'unlinked_transfer_in', 'unlinked_transfer_out'
      )
        AND NOT EXISTS (SELECT 1 FROM movement_legs leg WHERE leg.ledger_entry_id = le.id)
        AND NOT EXISTS (SELECT 1 FROM categorization_rules rule WHERE rule.enabled=1
          AND json_extract(rule.match_json,'$.type')='confirmed-entry-category-v1'
          AND json_extract(rule.match_json,'$.entryId')=le.id AND json_extract(rule.match_json,'$.confirmedFx')=1)
      ORDER BY le.id
    `);
    const ids = rows
      .filter((row) => {
        const searchable = `${row.sourceCategory ?? ""} ${row.description ?? ""}`;
        const merchantFxPayment = hasMerchantFxPaymentSignal(searchable);
        const movementEvidence = hasOwnTransferSignal(searchable)
          || hasExternalAccountTransferSignal(searchable)
          || (hasFxSignal(searchable) && !merchantFxPayment);
        if (row.entryKind === "unlinked_transfer_in" || row.entryKind === "unlinked_transfer_out") {
          return hasMobileTopUpSignal(searchable) || merchantFxPayment || !movementEvidence;
        }
        return movementEvidence;
      })
      .map(({ id }) => id);
    let resetEntries = 0;
    let removedAutomaticAssignments = 0;
    await this.#database.transaction(async () => {
      const legacyPersonalAssignments = await this.#database.all<{ id: string }>(`
        SELECT assignment.id
        FROM category_assignments assignment
        JOIN ledger_entries entry ON entry.id = assignment.ledger_entry_id
        JOIN accounts account ON account.id = entry.account_id
        WHERE account.owner_scope = 'PERSONAL'
          AND assignment.method NOT IN ('manual', 'user_rule')
          AND COALESCE(assignment.classification_version, '') <> 'canonical-v2'
        ORDER BY assignment.id
      `);
      for (const assignment of legacyPersonalAssignments) {
        const removed = await this.#database.run("DELETE FROM category_assignments WHERE id = ?", [assignment.id]);
        removedAutomaticAssignments += removed.changes;
      }
      const staleOtherAssignments = await this.#database.all<{ id: string; mcc: string | null }>(`
        SELECT assignment.id,
          (SELECT json_extract(record.source_metadata_json, '$.mcc')
           FROM transaction_evidence evidence
           JOIN source_records record ON record.id = evidence.source_record_id
           WHERE evidence.ledger_entry_id = assignment.ledger_entry_id
           ORDER BY evidence.rowid LIMIT 1) AS mcc
        FROM category_assignments assignment
        JOIN categories category ON category.id = assignment.category_id
        JOIN ledger_entries entry ON entry.id = assignment.ledger_entry_id
        JOIN accounts account ON account.id = entry.account_id
        WHERE account.owner_scope = 'PERSONAL'
          AND category.code = 'other'
          AND assignment.method NOT IN ('manual', 'user_rule')
        ORDER BY assignment.id
      `);
      for (const assignment of staleOtherAssignments) {
        if (!categoryForMcc(assignment.mcc)) continue;
        const removed = await this.#database.run("DELETE FROM category_assignments WHERE id = ?", [assignment.id]);
        removedAutomaticAssignments += removed.changes;
      }
      for (const id of ids) {
        const reset = await this.#database.run("UPDATE ledger_entries SET entry_kind = 'unclassified' WHERE id = ?", [id]);
        resetEntries += reset.changes;
        const removed = await this.#database.run(
          "DELETE FROM category_assignments WHERE ledger_entry_id = ? AND method NOT IN ('manual', 'user_rule')",
          [id],
        );
        removedAutomaticAssignments += removed.changes;
      }
    });
    return { resetEntries, removedAutomaticAssignments };
  }
}

import { randomUUID } from "node:crypto";

import type { EncryptedDatabase } from "@/server/db/database";
import type { OwnerScope } from "@/server/import/types";
import {
  hasExternalAccountTransferSignal,
  hasFxSignal,
  hasMerchantFxPaymentSignal,
  hasMobileTopUpSignal,
  hasOwnTransferSignal,
} from "@/domain/transaction-signals";

interface EntryRow {
  id: string;
  ownerScope: OwnerScope;
  direction: "debit" | "credit";
  description: string | null;
  sourceCategory: string | null;
  heldByCandidate: number;
}

type ClassifiedKind =
  | "business_income"
  | "tax"
  | "mandatory_payment"
  | "business_expense"
  | "explicit_fee"
  | "personal_income"
  | "terminal_personal_expense"
  | "unlinked_transfer_in"
  | "unlinked_transfer_out";

const CATEGORY_BY_KIND: Partial<Record<ClassifiedKind, string>> = {
  business_income: "business-gross-income",
  tax: "business-tax",
  mandatory_payment: "business-mandatory",
  business_expense: "business-expense",
  explicit_fee: "business-bank-fee",
};

const MANDATORY_PATTERN = /(?:\bєсв\b|єдиний\s+соціальн|військов|mandatory|contribution)/iu;
const TAX_PATTERN = /(?:подат|\btax\b|казначейств)/iu;
const FEE_PATTERN = /(?:комісі|\bfee\b|commission)/iu;
function classify(row: EntryRow): ClassifiedKind | null {
  if (row.heldByCandidate === 1) return null;
  if (row.direction === "debit" && row.sourceCategory === "bank_fee") return "explicit_fee";
  const searchable = `${row.sourceCategory ?? ""} ${row.description ?? ""}`.normalize("NFKC");
  const merchantFxPayment = row.direction === "debit" && hasMerchantFxPaymentSignal(searchable);
  if (row.ownerScope === "PERSONAL" && row.direction === "debit" && (hasMobileTopUpSignal(searchable) || merchantFxPayment)) {
    return "terminal_personal_expense";
  }
  if (hasOwnTransferSignal(searchable) || hasExternalAccountTransferSignal(searchable) || (hasFxSignal(searchable) && !merchantFxPayment)) {
    return row.direction === "debit" ? "unlinked_transfer_out" : "unlinked_transfer_in";
  }
  if (row.ownerScope === "SOLE_PROPRIETOR") {
    if (row.direction === "credit") return "business_income";
    if (MANDATORY_PATTERN.test(searchable)) return "mandatory_payment";
    if (TAX_PATTERN.test(searchable)) return "tax";
    if (FEE_PATTERN.test(searchable)) return "explicit_fee";
    return "business_expense";
  }
  if (row.direction === "credit") return "personal_income";
  if (FEE_PATTERN.test(searchable)) return "explicit_fee";
  return "terminal_personal_expense";
}

export class EntryClassificationService {
  readonly #database: EncryptedDatabase;

  constructor(database: EncryptedDatabase) {
    this.#database = database;
  }

  async refresh(): Promise<{ classified: number; heldForReview: number }> {
    const entries = await this.#database.all<EntryRow>(`
      SELECT
        le.id,
        a.owner_scope AS ownerScope,
        le.direction,
        le.private_description AS description,
        (
          SELECT COALESCE(json_extract(sr.source_metadata_json, '$.sourceCategory'), json_extract(sr.source_metadata_json, '$.statementCategory'))
          FROM transaction_evidence te
          JOIN source_records sr ON sr.id = te.source_record_id
          WHERE te.ledger_entry_id = le.id
          ORDER BY te.rowid
          LIMIT 1
        ) AS sourceCategory,
        EXISTS (
          SELECT 1 FROM movement_candidates mc
          WHERE mc.status IN ('pending', 'confirmed')
            AND (mc.debit_entry_id = le.id OR mc.credit_entry_id = le.id)
        ) AS heldByCandidate
      FROM ledger_entries le
      JOIN accounts a ON a.id = le.account_id
      WHERE le.entry_kind = 'unclassified'
        AND NOT EXISTS (SELECT 1 FROM movement_legs ml WHERE ml.ledger_entry_id = le.id)
      ORDER BY le.occurred_at, le.id
    `);

    let classified = 0;
    let heldForReview = 0;
    await this.#database.transaction(async () => {
      for (const entry of entries) {
        const kind = classify(entry);
        if (!kind) {
          heldForReview += 1;
          continue;
        }
        await this.#database.run(
          "UPDATE ledger_entries SET entry_kind = ? WHERE id = ? AND entry_kind = 'unclassified'",
          [kind, entry.id],
        );
        const categoryId = entry.ownerScope === "SOLE_PROPRIETOR" ? CATEGORY_BY_KIND[kind] : undefined;
        if (categoryId) {
          await this.#database.run(
            "INSERT INTO category_assignments (id, ledger_entry_id, category_id, method, confidence_text, needs_review, classification_version, evidence_json) VALUES (?, ?, ?, 'deterministic', '1', 0, 'canonical-v2', ?)",
            [randomUUID(), entry.id, categoryId, JSON.stringify({ classificationVersion: "canonical-v2" })],
          );
        }
        classified += 1;
      }
    });
    return { classified, heldForReview };
  }
}

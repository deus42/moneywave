import { randomUUID } from "node:crypto";

import {
  classifyPersonalEntry,
  type PersonalCategorizationResult,
} from "@/domain/personal-categorization";
import type { EncryptedDatabase } from "@/server/db/database";
import { MCC_RULE_VERSION, normalizeCategoryAlias } from "./mcc";

import {CATEGORY_POLICY_VERSION,policyCategoryCode} from "@/domain/category-policy";
import {CategoryPolicyService} from "./category-policy-service";

const CLASSIFICATION_VERSION = "canonical-v2";
const AI_CHUNK_SIZE = 20;

interface EntryRow {
  id: string;
  direction: "debit" | "credit";
  entryKind: string;
  description: string | null;
  sourceCategory: string | null;
  mcc: string | null;
  providerCode: string;
}

interface CategoryRow {
  id: string;
  code: string;
}

interface AliasRow {
  id: string;
  providerCode: string;
  normalizedAlias: string;
  categoryCode: string;
  priority: number;
}

export interface AutonomousBatchCategoryClassifier {
  categorizeBatch(
    merchantLabels: readonly string[],
    allowedCategoryCodes: readonly string[],
  ): Promise<Array<{ categoryCode: string; confidence: number }>>;
}

interface PendingAssignment {
  entry: EntryRow;
  result: Extract<PersonalCategorizationResult, { state: "assigned" }> | {
    state: "assigned";
    categoryCode: string;
    method: "openai_codex";
    confidence: number;
    terminalSpend: true;
  };
}

export interface AutonomousCategorizationResult {
  assigned: number;
  deterministic: number;
  bank: number;
  alias: number;
  mcc: number;
  merchantHeuristic: number;
  openaiCodex: number;
  pendingOpenAI: number;
}

function freshCounts(): AutonomousCategorizationResult {
  return { assigned: 0, deterministic: 0, bank: 0, alias: 0, mcc: 0, merchantHeuristic: 0, openaiCodex: 0, pendingOpenAI: 0 };
}

function matchingAlias(entry: EntryRow, aliases: readonly AliasRow[]): AliasRow | null {
  const values = new Set([entry.sourceCategory, entry.description]
    .flatMap((value) => value ? [normalizeCategoryAlias(value)] : [])
    .filter(Boolean));
  return aliases
    .filter((alias) => values.has(alias.normalizedAlias) && (alias.providerCode === entry.providerCode || alias.providerCode === "*"))
    .sort((left, right) => right.priority - left.priority
      || Number(right.providerCode === entry.providerCode) - Number(left.providerCode === entry.providerCode)
      || left.id.localeCompare(right.id))[0] ?? null;
}

export class AutonomousCategorizationService {
  readonly #database: EncryptedDatabase;
  readonly #classifier: AutonomousBatchCategoryClassifier;

  constructor(database: EncryptedDatabase, classifier: AutonomousBatchCategoryClassifier) {
    this.#database = database;
    this.#classifier = classifier;
  }

  async run(): Promise<AutonomousCategorizationResult> {
    const policy=await new CategoryPolicyService(this.#database).apply();
    const [entries, categories, aliases] = await Promise.all([
      this.#eligibleEntries(),
      this.#database.all<CategoryRow>("SELECT id, code FROM categories WHERE scope = 'personal' ORDER BY code"),
      this.#database.all<AliasRow>(`
        SELECT alias.id, alias.provider_code AS providerCode, alias.normalized_alias AS normalizedAlias,
          category.code AS categoryCode, alias.priority
        FROM category_aliases alias
        JOIN categories category ON category.id = alias.category_id
        WHERE alias.enabled = 1 AND category.scope = 'personal'
        ORDER BY alias.priority DESC, alias.id
      `),
    ]);
    if (entries.length === 0) return {...freshCounts(),assigned:policy.assigned,deterministic:policy.assigned};
    const categoryByCode = new Map(categories.map((category) => [category.code, category]));
    const allowedForAi = categories
      .map(({ code }) => code)
      .filter((code) => policyCategoryCode(code)===code && !["personal_income", "transfers", "other_payouts"].includes(code));
    const immediate: PendingAssignment[] = [];
    const aiRows: Array<{ entry: EntryRow; merchantLabel: string }> = [];
    const aliasByEntry = new Map<string, AliasRow>();
    for (const entry of entries) {
      const alias = matchingAlias(entry, aliases);
      if (alias) aliasByEntry.set(entry.id, alias);
      const result = classifyPersonalEntry({ ...entry, aliasCategoryCode: alias?.categoryCode ?? null });
      if (result.state === "ai_required") aiRows.push({ entry, merchantLabel: result.merchantLabel });
      else immediate.push({ entry, result });
    }

    const aiAssignments: PendingAssignment[] = [];
    let pendingOpenAI = 0;
    if (aiRows.length > 0) {
      const uniqueLabels = [...new Set(aiRows.map(({ merchantLabel }) => merchantLabel))];
      const byLabel = new Map<string, { categoryCode: string; confidence: number }>();
      const unavailableLabels = new Set<string>();
      for (let offset = 0; offset < uniqueLabels.length; offset += AI_CHUNK_SIZE) {
        const labels = uniqueLabels.slice(offset, offset + AI_CHUNK_SIZE);
        try {
          const classifications = await this.#classifier.categorizeBatch(labels, allowedForAi);
          if (classifications.length !== labels.length) throw new Error("OPENAI_OUTPUT_INVALID");
          for (let index = 0; index < labels.length; index += 1) {
            const classification = classifications[index];
            if (
              !classification
              || !allowedForAi.includes(classification.categoryCode)
              || !Number.isFinite(classification.confidence)
              || classification.confidence < 0
              || classification.confidence > 1
            ) throw new Error("OPENAI_OUTPUT_INVALID");
          }
          for (const [index, label] of labels.entries()) byLabel.set(label, classifications[index]!);
        } catch {
          for (const label of labels) unavailableLabels.add(label);
        }
      }
      pendingOpenAI = aiRows.filter(({ merchantLabel }) => unavailableLabels.has(merchantLabel)).length;
      for (const row of aiRows) {
        const classification = byLabel.get(row.merchantLabel);
        if (!classification) continue;
        aiAssignments.push({
          entry: row.entry,
          result: { state: "assigned", categoryCode: classification.categoryCode, method: "openai_codex", confidence: classification.confidence, terminalSpend: true },
        });
      }
    }

    const assignments = [...immediate, ...aiAssignments];
    const counts = freshCounts();
    counts.assigned=policy.assigned;counts.deterministic=policy.assigned;
    counts.pendingOpenAI = pendingOpenAI;
    await this.#database.transaction(async () => {
      for (const assignment of assignments) {
        const category = categoryByCode.get(assignment.result.categoryCode);
        if (!category) throw new Error("AUTOMATIC_CATEGORY_NOT_FOUND");
        const inserted = await this.#database.run(
          `INSERT INTO category_assignments (
             id, ledger_entry_id, category_id, method, confidence_text, needs_review,
             classification_version, evidence_json
           )
           SELECT ?, ?, ?, ?, ?, 0, ?, ?
           WHERE NOT EXISTS (SELECT 1 FROM category_assignments WHERE ledger_entry_id = ?)`,
          [
            randomUUID(),
            assignment.entry.id,
            category.id,
            assignment.result.method,
            assignment.result.confidence.toString(),
            assignment.result.method === "user_rule" ? CATEGORY_POLICY_VERSION : CLASSIFICATION_VERSION,
            JSON.stringify(
              assignment.result.method === "alias"
                ? { aliasId: aliasByEntry.get(assignment.entry.id)?.id ?? null }
                : assignment.result.method === "mcc"
                  ? { ruleVersion: MCC_RULE_VERSION, mcc: assignment.entry.mcc }
                  : { classificationVersion: CLASSIFICATION_VERSION, categoryPolicyVersion:CATEGORY_POLICY_VERSION },
            ),
            assignment.entry.id,
          ],
        );
        if (inserted.changes !== 1) continue;
        if (assignment.entry.entryKind === "unclassified") {
          const entryKind = assignment.result.categoryCode === "transfers"
            ? assignment.entry.direction === "debit" ? "unlinked_transfer_out" : "unlinked_transfer_in"
            : assignment.result.categoryCode === "personal_income"
              ? "personal_income"
              : "terminal_personal_expense";
          await this.#database.run("UPDATE ledger_entries SET entry_kind = ? WHERE id = ? AND entry_kind = 'unclassified'", [entryKind, assignment.entry.id]);
        }
        counts.assigned += 1;
        if (["deterministic","user_rule"].includes(assignment.result.method)) counts.deterministic += 1;
        else if (assignment.result.method === "bank") counts.bank += 1;
        else if (assignment.result.method === "alias") counts.alias += 1;
        else if (assignment.result.method === "mcc") counts.mcc += 1;
        else if (assignment.result.method === "merchant_heuristic") counts.merchantHeuristic += 1;
        else if (assignment.result.method === "openai_codex") counts.openaiCodex += 1;
      }
      if (counts.assigned > 0 || counts.pendingOpenAI > 0) {
        await this.#database.run(
          "INSERT INTO audit_events (id, event_code, entity_type, entity_id, safe_details_json) VALUES (?, 'AUTONOMOUS_CATEGORIZATION_COMPLETED', 'categorization_run', ?, ?)",
          [randomUUID(), randomUUID(), JSON.stringify(counts)],
        );
      }
    });
    return counts;
  }

  async #eligibleEntries(): Promise<EntryRow[]> {
    return this.#database.all<EntryRow>(`
      SELECT
        le.id,
        le.direction,
        le.entry_kind AS entryKind,
        le.private_description AS description,
        p.code AS providerCode,
        (
          SELECT COALESCE(json_extract(sr.source_metadata_json, '$.sourceCategory'), json_extract(sr.source_metadata_json, '$.statementCategory'))
          FROM transaction_evidence te
          JOIN source_records sr ON sr.id = te.source_record_id
          WHERE te.ledger_entry_id = le.id
          ORDER BY te.rowid
          LIMIT 1
        ) AS sourceCategory,
        (
          SELECT json_extract(sr.source_metadata_json, '$.mcc')
          FROM transaction_evidence te
          JOIN source_records sr ON sr.id = te.source_record_id
          WHERE te.ledger_entry_id = le.id
          ORDER BY te.rowid
          LIMIT 1
        ) AS mcc
      FROM ledger_entries le
      JOIN accounts a ON a.id = le.account_id
      JOIN providers p ON p.id = a.provider_id
      WHERE a.owner_scope = 'PERSONAL'
        AND NOT EXISTS (SELECT 1 FROM category_assignments ca WHERE ca.ledger_entry_id = le.id)
      ORDER BY le.occurred_at, le.id
    `);
  }
}

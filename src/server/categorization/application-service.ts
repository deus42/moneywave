import { randomUUID } from "node:crypto";

import {
  CategorizationService,
  sanitizeForCategorization,
  type CategoryClassifier,
} from "@/domain/categorization";
import type { EncryptedDatabase } from "@/server/db/database";
import type { OwnerScope } from "@/server/import/types";

interface EligibleEntry {
  id: string;
  direction: "debit" | "credit";
  ownerScope: OwnerScope;
  entryKind: string;
}

interface CategoryRow {
  id: string;
  code: string;
}

export class CategorizationApplicationService {
  readonly #database: EncryptedDatabase;
  readonly #classifier: CategoryClassifier;
  readonly #categorization = new CategorizationService();

  constructor(database: EncryptedDatabase, classifier: CategoryClassifier) {
    this.#database = database;
    this.#classifier = classifier;
  }

  async categorizeWithOpenAI(entryId: string, merchantLabel: string): Promise<{
    categoryCode: string;
    confidence: number;
    needsReview: boolean;
  }> {
    const entry = await this.#entry(entryId);
    if (
      entry.direction !== "debit"
      || entry.ownerScope !== "PERSONAL"
      || !["unclassified", "terminal_personal_expense"].includes(entry.entryKind)
    ) {
      throw new Error("OPENAI_ENTRY_NOT_ELIGIBLE");
    }
    const sanitizedLabel = sanitizeForCategorization(merchantLabel).slice(0, 512);
    if (!sanitizedLabel) throw new Error("OPENAI_INPUT_EMPTY");
    const categories = await this.#database.all<CategoryRow>(
      "SELECT id, code FROM categories WHERE scope = 'personal' AND editable = 1 AND code <> 'personal_income' ORDER BY code",
    );
    const result = await this.#categorization.categorize({
      id: entry.id,
      description: sanitizedLabel,
      direction: entry.direction,
      ownerScope: entry.ownerScope,
      entryKind: entry.entryKind,
    }, {
      userRules: [],
      merchantHeuristics: [],
      bankCategoryMap: {},
      ai: this.#classifier,
      allowedCategoryCodes: categories.map(({ code }) => code),
    });
    if (result.state !== "assigned" || result.method !== "openai_codex" || result.confidence === null) {
      throw new Error(result.state === "categorization_pending" ? result.reasonCode : "OPENAI_OUTPUT_INVALID");
    }
    const category = categories.find(({ code }) => code === result.categoryCode);
    if (!category) throw new Error("OPENAI_OUTPUT_INVALID");
    await this.#database.run(
      "INSERT INTO category_assignments (id, ledger_entry_id, category_id, method, confidence_text, needs_review) VALUES (?, ?, ?, 'openai_codex', ?, ?)",
      [randomUUID(), entry.id, category.id, result.confidence.toString(), result.needsReview ? 1 : 0],
    );
    return {
      categoryCode: result.categoryCode,
      confidence: result.confidence,
      needsReview: result.needsReview,
    };
  }

  async assignManual(entryId: string, categoryCode: string): Promise<void> {
    const entry = await this.#entry(entryId);
    const scope = entry.ownerScope === "PERSONAL" ? "personal" : "business";
    const category = await this.#database.get<CategoryRow>(
      "SELECT id, code FROM categories WHERE scope = ? AND code = ?",
      [scope, categoryCode],
    );
    if (!category) throw new Error("CATEGORY_NOT_ALLOWED");
    await this.#database.run(
      "INSERT INTO category_assignments (id, ledger_entry_id, category_id, method, confidence_text, needs_review) VALUES (?, ?, ?, 'manual', NULL, 0)",
      [randomUUID(), entry.id, category.id],
    );
  }

  async assignCustom(entryId: string, name: string): Promise<{ categoryCode: string; displayName: string }> {
    if (/\p{C}/u.test(name)) throw new Error("CATEGORY_NAME_INVALID");
    const displayName = name.normalize("NFC").trim().replace(/\s+/gu, " ");
    if (!displayName || displayName.length > 80) throw new Error("CATEGORY_NAME_INVALID");
    return this.#database.transaction(async () => {
      const entry = await this.#entry(entryId);
      if (entry.direction !== "debit" || !["terminal_personal_expense", "business_expense"].includes(entry.entryKind)) throw new Error("CATEGORY_ENTRY_NOT_ELIGIBLE");
      const scope = entry.ownerScope === "PERSONAL" ? "personal" : "business";
      const options = await this.#database.all<CategoryRow & { displayName: string }>("SELECT id,code,display_name AS displayName FROM categories WHERE scope=? AND editable=1",[scope]);
      let category = options.find(c => c.displayName.normalize("NFC").trim().replace(/\s+/gu," ").toLocaleLowerCase("uk") === displayName.toLocaleLowerCase("uk"));
      if (!category) {
        category = { id:randomUUID(), code:`custom_${randomUUID().replace(/-/g,"")}`, displayName };
        await this.#database.run("INSERT INTO categories (id,scope,code,display_name,editable) VALUES (?,?,?,?,1)",[category.id,scope,category.code,displayName]);
      }
      const latest = await this.#database.get<{ categoryId:string; method:string }>("SELECT category_id AS categoryId,method FROM category_assignments WHERE ledger_entry_id=? ORDER BY assigned_at DESC,rowid DESC LIMIT 1",[entryId]);
      if (latest?.categoryId !== category.id || latest.method !== "manual") {
        await this.#database.run("INSERT INTO category_assignments (id,ledger_entry_id,category_id,method,confidence_text,needs_review) VALUES (?,?,?,'manual',NULL,0)",[randomUUID(),entryId,category.id]);
        await this.#database.run("INSERT INTO audit_events (id,event_code,entity_type,entity_id,safe_details_json) VALUES (?,'CUSTOM_CATEGORY_ASSIGNED','ledger_entry',?,'{}')",[randomUUID(),entryId]);
      }
      return { categoryCode:category.code, displayName:category.displayName };
    });
  }

  async acceptLatest(entryId: string): Promise<void> {
    await this.#entry(entryId);
    await this.#database.transaction(async () => {
      const latest = await this.#database.get<{ id: string; needsReview: number }>(
        "SELECT id, needs_review AS needsReview FROM category_assignments WHERE ledger_entry_id = ? ORDER BY assigned_at DESC, rowid DESC LIMIT 1",
        [entryId],
      );
      if (!latest || latest.needsReview !== 1) throw new Error("CATEGORY_REVIEW_NOT_PENDING");
      const updated = await this.#database.run(
        "UPDATE category_assignments SET needs_review = 0 WHERE id = ? AND needs_review = 1",
        [latest.id],
      );
      if (updated.changes !== 1) throw new Error("CATEGORY_REVIEW_NOT_PENDING");
      await this.#database.run(
        "INSERT INTO audit_events (id, event_code, entity_type, entity_id, safe_details_json) VALUES (?, 'CATEGORY_ASSIGNMENT_ACCEPTED', 'ledger_entry', ?, '{}')",
        [randomUUID(), entryId],
      );
    });
  }

  async #entry(entryId: string): Promise<EligibleEntry> {
    const entry = await this.#database.get<EligibleEntry>(`
      SELECT le.id, le.direction, le.entry_kind AS entryKind, a.owner_scope AS ownerScope
      FROM ledger_entries le
      JOIN accounts a ON a.id = le.account_id
      WHERE le.id = ?
    `, [entryId]);
    if (!entry) throw new Error("LEDGER_ENTRY_NOT_FOUND");
    return entry;
  }
}

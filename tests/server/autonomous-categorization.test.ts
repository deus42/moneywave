import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {CategorizationApplicationService} from "@/server/categorization/application-service";
import { CategoryPolicyService } from "@/server/categorization/category-policy-service";
import { ReclassificationPreparationService } from "@/server/categorization/reclassification-preparation";
import { AutonomousCategorizationService } from "@/server/categorization/autonomous-service";
import { openEncryptedDatabase, type EncryptedDatabase } from "@/server/db/database";
import { applyMigrations } from "@/server/db/migrations";

describe("autonomous personal categorization", () => {
  let directory: string;
  let database: EncryptedDatabase;
  let batchId: string;
  let sourceRow: number;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "moneywave-auto-category-"));
    database = await openEncryptedDatabase(join(directory, "moneywave.db"), Buffer.alloc(32, 83));
    await applyMigrations(database);
    sourceRow = 0;
    await database.run("INSERT INTO providers (id, code, display_name) VALUES ('provider-synthetic', 'privatbank', 'Synthetic')");
    await database.run("INSERT INTO accounts (id, provider_id, owner_scope, account_type, currency, display_name, identifier_hmac) VALUES ('personal', 'provider-synthetic', 'PERSONAL', 'card', 'UAH', 'Synthetic personal', ?)", ["a".repeat(64)]);
    const artifactId = randomUUID();
    batchId = randomUUID();
    await database.run("INSERT INTO import_artifacts (id, sha256, encrypted_bytes, size_bytes, parser_kind, parser_version) VALUES (?, ?, ?, 9, 'privat_personal', '1')", [artifactId, "f".repeat(64), Buffer.from("SYNTHETIC")]);
    await database.run("INSERT INTO import_batches (id, artifact_id, status, row_count) VALUES (?, ?, 'committed', 20)", [batchId, artifactId]);
  });

  afterEach(async () => {
    await database.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });

  async function addEntry(input: {
    id: string;
    direction?: "debit" | "credit";
    kind?: string;
    description: string;
    sourceCategory?: string;
    mcc?: string;
  }): Promise<void> {
    sourceRow += 1;
    const direction = input.direction ?? "debit";
    const amount = direction === "debit" ? -1_000 : 1_000;
    const sourceId = randomUUID();
    await database.run(
      "INSERT INTO source_records (id, batch_id, source_row_number, dedupe_fingerprint, row_state, source_metadata_json) VALUES (?, ?, ?, ?, 'posted', ?)",
      [sourceId, batchId, sourceRow, randomUUID().replaceAll("-", "").padEnd(64, "0").slice(0, 64), JSON.stringify({ sourceCategory: input.sourceCategory ?? null, mcc: input.mcc ?? null })],
    );
    await database.run(
      "INSERT INTO ledger_entries (id, account_id, amount_minor, currency, direction, occurred_at, entry_kind, private_description) VALUES (?, 'personal', ?, 'UAH', ?, '2099-01-01T10:00:00', ?, ?)",
      [input.id, amount, direction, input.kind ?? "terminal_personal_expense", input.description],
    );
    await database.run(
      "INSERT INTO transaction_evidence (id, ledger_entry_id, source_record_id, observed_amount_minor, observed_currency, observed_direction) VALUES (?, ?, ?, ?, 'UAH', ?)",
      [randomUUID(), input.id, sourceId, amount, direction],
    );
  }

  it("categorizes bank, merchant, AI, transfer, and income shapes without a review queue", async () => {
    await addEntry({ id: "bank", description: "SYNTHETIC PURCHASE", sourceCategory: "Продукти та супермаркети" });
    await addEntry({ id: "merchant", description: "SYNTHETIC UBER TRIP" });
    await addEntry({ id: "ai", description: "SYNTHETIC NOVEL MERCHANT card 4444333322221111 ref ABC-123 100 UAH" });
    await addEntry({ id: "transfer", kind: "unclassified", description: "SYNTHETIC TRANSFER BETWEEN OWN CARDS" });
    await addEntry({ id: "income", direction: "credit", kind: "unclassified", description: "SYNTHETIC CREDIT" });
    const categorizeBatch = vi.fn(async (labels: readonly string[]) => labels.map(() => ({ categoryCode: "education", confidence: 0.61 })));
    const service = new AutonomousCategorizationService(database, { categorizeBatch });

    const result = await service.run();

    expect(result).toMatchObject({ assigned: 5, bank: 1, merchantHeuristic: 1, openaiCodex: 1, deterministic: 2, pendingOpenAI: 0 });
    expect(categorizeBatch).toHaveBeenCalledTimes(1);
    const serializedCall = JSON.stringify(categorizeBatch.mock.calls);
    expect(serializedCall).toContain("SYNTHETIC NOVEL MERCHANT");
    expect(serializedCall).not.toMatch(/4444|ABC-123|100 UAH/);
    expect(await database.all<{ entryId: string; code: string; method: string; review: number }>(`
      SELECT ca.ledger_entry_id AS entryId, c.code, ca.method, ca.needs_review AS review
      FROM category_assignments ca JOIN categories c ON c.id = ca.category_id
      ORDER BY ca.ledger_entry_id
    `)).toEqual([
      { entryId: "ai", code: "education", method: "openai_codex", review: 0 },
      { entryId: "bank", code: "groceries", method: "bank", review: 0 },
      { entryId: "income", code: "personal_income", method: "deterministic", review: 0 },
      { entryId: "merchant", code: "transport", method: "merchant_heuristic", review: 0 },
      { entryId: "transfer", code: "transfers", method: "deterministic", review: 0 },
    ]);
    expect(await database.get<{ kind: string }>("SELECT entry_kind AS kind FROM ledger_entries WHERE id = 'transfer'"))
      .toEqual({ kind: "unlinked_transfer_out" });
    expect(await service.run()).toMatchObject({ assigned: 0 });
  });

  it("applies provider aliases and MCC before invoking the sanitized AI fallback", async () => {
    await database.run(
      "INSERT INTO category_aliases (id, provider_code, normalized_alias, category_id, priority) VALUES ('alias', 'privatbank', 'spreadsheet learning', 'personal-education', 100)",
    );
    await addEntry({ id: "alias", description: "SYNTHETIC PURCHASE", sourceCategory: "Spreadsheet Learning", mcc: "5411" });
    await addEntry({ id: "mcc", description: "SYNTHETIC UNKNOWN SHOP", sourceCategory: "Інше", mcc: "5411" });
    await addEntry({ id: "ai", description: "SYNTHETIC NOVEL MERCHANT" });
    const categorizeBatch = vi.fn(async () => [{ categoryCode: "travel", confidence: 0.91 }]);

    expect(await new AutonomousCategorizationService(database, { categorizeBatch }).run()).toMatchObject({
      assigned: 3,
      alias: 1,
      mcc: 1,
      openaiCodex: 1,
    });
    expect(categorizeBatch).toHaveBeenCalledTimes(1);
    expect(await database.all<{ entryId: string; code: string; method: string; version: string }>(`
      SELECT assignment.ledger_entry_id AS entryId, category.code, assignment.method,
        assignment.classification_version AS version
      FROM category_assignments assignment
      JOIN categories category ON category.id = assignment.category_id
      ORDER BY assignment.ledger_entry_id
    `)).toEqual([
      { entryId: "ai", code: "travel", method: "openai_codex", version: "canonical-v2" },
      { entryId: "alias", code: "education", method: "alias", version: "canonical-v2" },
      { entryId: "mcc", code: "groceries", method: "mcc", version: "canonical-v2" },
    ]);
  });

  it("leaves unknown merchants pending when the classifier is unavailable so a later run can retry", async () => {
    await addEntry({ id: "unknown", description: "SYNTHETIC UNKNOWN MERCHANT" });
    const service = new AutonomousCategorizationService(database, {
      categorizeBatch: async () => { throw new Error("SYNTHETIC_UNAVAILABLE"); },
    });

    expect(await service.run()).toMatchObject({ assigned: 0, pendingOpenAI: 1, openaiCodex: 0 });
    expect(await database.get<{ count: number }>(
      "SELECT count(*) AS count FROM category_assignments WHERE ledger_entry_id = 'unknown'",
    )).toEqual({ count: 0 });
  });

  it("persists successful AI chunks when a later chunk is unavailable", async () => {
    for (let index = 0; index < 21; index += 1) {
      await addEntry({
        id: `partial-${String(index).padStart(2, "0")}`,
        description: `SYNTHETIC NOVEL MERCHANT ${String.fromCharCode(65 + index)}`,
      });
    }
    const categorizeBatch = vi.fn(async (labels: readonly string[]) => {
      if (labels.some((label) => label.endsWith(" U"))) throw new Error("SYNTHETIC_UNAVAILABLE");
      return labels.map(() => ({ categoryCode: "other", confidence: 0.75 }));
    });

    const result = await new AutonomousCategorizationService(database, { categorizeBatch }).run();

    expect(result).toMatchObject({ assigned: 20, openaiCodex: 20, pendingOpenAI: 1 });
    expect(categorizeBatch).toHaveBeenCalledTimes(2);
    expect(await database.get<{ count: number }>("SELECT count(*) AS count FROM category_assignments"))
      .toEqual({ count: 20 });
  });

  it("reprocesses confirmed rules, retains manual categories and does not infer FX from amounts", async () => {
    for (const id of ["synthetic-coffee", "synthetic-manual", "synthetic-fx", "synthetic-grocery", "synthetic-sport"]) {
      await addEntry({id, description:id.includes("coffee") || id.includes("manual") ? "SYNTHETIC Circle Coffee" : "SYNTHETIC purchase", sourceCategory:id.includes("grocery") ? "Продукти" : undefined});
    }
    for (const [id,category,method] of [["synthetic-coffee","dining","bank"],["synthetic-manual","education","manual"],["synthetic-sport","fitness","mcc"]]) {
      await database.run("INSERT INTO category_assignments(id,ledger_entry_id,category_id,method,classification_version) VALUES(?,?,?,?, 'canonical-v2')",[randomUUID(),id,`personal-${category}`,method]);
    }
    const policy=new CategoryPolicyService(database);
    await policy.saveConfirmedRules([{entryId:"synthetic-fx",categoryCode:"transfers",confirmedFx:true}]);
    const classifier={categorizeBatch:vi.fn(async()=>{throw new Error("MUST_NOT_CALL_AI");})};
    const service=new AutonomousCategorizationService(database,classifier);
    await new ReclassificationPreparationService(database).run();
    await service.run();
    const current=()=>database.all<{id:string;kind:string;code:string}>(`SELECT e.id,e.entry_kind AS kind,c.code FROM ledger_entries e
      JOIN category_assignments a ON a.rowid=(SELECT rowid FROM category_assignments WHERE ledger_entry_id=e.id ORDER BY assigned_at DESC,rowid DESC LIMIT 1)
      JOIN categories c ON c.id=a.category_id ORDER BY e.id`);
    expect(await current()).toEqual([
      {id:"synthetic-coffee",kind:"terminal_personal_expense",code:"coffee"},
      {id:"synthetic-fx",kind:"unlinked_transfer_out",code:"transfers"},
      {id:"synthetic-grocery",kind:"terminal_personal_expense",code:"groceries"},
      {id:"synthetic-manual",kind:"terminal_personal_expense",code:"education"},
      {id:"synthetic-sport",kind:"terminal_personal_expense",code:"travel"},
    ]);
    const count=await database.get("SELECT count(*) AS n FROM category_assignments");
    await new ReclassificationPreparationService(database).run();await service.run();
    expect(await database.get("SELECT count(*) AS n FROM category_assignments")).toEqual(count);
    expect((await current()).find(r=>r.id==="synthetic-fx")?.kind).toBe("unlinked_transfer_out");
    expect(classifier.categorizeBatch).not.toHaveBeenCalled();
    expect(await database.get("SELECT count(*) AS n FROM movement_legs")).toEqual({n:0});
  });

  it("applies new merchant rules on an unclassified import and protects them from an AI recategorization", async () => {
    await addEntry({id:"synthetic-new-circle",kind:"unclassified",description:"SYNTHETIC Coffee Circl",mcc:"5814"});
    const classifier={categorizeBatch:vi.fn(async()=>{throw new Error("MUST_NOT_CALL_AI");})};
    await new AutonomousCategorizationService(database,classifier).run();
    expect(await database.get("SELECT entry_kind AS kind FROM ledger_entries WHERE id='synthetic-new-circle'"))
      .toEqual({kind:"terminal_personal_expense"});
    expect(classifier.categorizeBatch).not.toHaveBeenCalled();
    await addEntry({id:"synthetic-other-circle",kind:"unclassified",description:"SYNTHETIC Circle Coffee"});
    const ai={categorize:vi.fn(async()=>{throw new Error("MUST_NOT_CALL_AI");})};
    const result=await new CategorizationApplicationService(database,ai).categorizeWithOpenAI("synthetic-new-circle","SYNTHETIC Circle Coffee");
    expect(result.categoryCode).toBe("coffee");expect(ai.categorize).not.toHaveBeenCalled();
    expect(await database.get("SELECT count(*) AS n FROM category_assignments WHERE ledger_entry_id='synthetic-other-circle'")).toEqual({n:0});
  });

  it("preserves an existing manual assignment", async () => {
    await addEntry({ id: "manual", description: "SYNTHETIC MERCHANT" });
    await database.run(
      "INSERT INTO category_assignments (id, ledger_entry_id, category_id, method, needs_review) VALUES (?, 'manual', 'personal-health', 'manual', 0)",
      [randomUUID()],
    );
    const categorizeBatch = vi.fn(async () => [{ categoryCode: "other", confidence: 0.5 }]);

    expect(await new AutonomousCategorizationService(database, { categorizeBatch }).run()).toMatchObject({ assigned: 0 });
    expect(categorizeBatch).not.toHaveBeenCalled();
  });
});

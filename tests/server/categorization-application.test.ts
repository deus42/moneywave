import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CategoryClassifier } from "@/domain/categorization";
import { CategorizationApplicationService } from "@/server/categorization/application-service";
import { openEncryptedDatabase, type EncryptedDatabase } from "@/server/db/database";
import { applyMigrations } from "@/server/db/migrations";

describe("categorization application service", () => {
  let directory: string;
  let database: EncryptedDatabase;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "moneywave-category-application-"));
    database = await openEncryptedDatabase(join(directory, "moneywave.db"), Buffer.alloc(32, 101));
    await applyMigrations(database);
    await database.run("INSERT INTO providers (id, code, display_name) VALUES ('provider-synthetic', 'privatbank', 'Synthetic')");
    await database.run("INSERT INTO accounts (id, provider_id, owner_scope, account_type, currency, display_name, identifier_hmac) VALUES ('personal', 'provider-synthetic', 'PERSONAL', 'card', 'UAH', 'Personal', ?)", ["a".repeat(64)]);
    await database.run("INSERT INTO ledger_entries (id, account_id, amount_minor, currency, direction, occurred_at, entry_kind, private_description) VALUES ('expense', 'personal', -1000, 'UAH', 'debit', '2099-01-01T10:00:00', 'terminal_personal_expense', 'PRIVATE RAW DESCRIPTION')");
  });

  afterEach(async () => {
    await database.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });

  it("sends only the explicit merchant label to the classifier and persists validated output", async () => {
    const categorize = vi.fn(async () => ({ categoryCode: "food", confidence: 0.79 }));
    const classifier: CategoryClassifier = { categorize };
    const service = new CategorizationApplicationService(database, classifier);

    const result = await service.categorizeWithOpenAI("expense", "SYNTHETIC CAFE");

    expect(categorize).toHaveBeenCalledWith("SYNTHETIC CAFE", expect.arrayContaining(["food", "housing", "transport"]));
    expect(JSON.stringify(categorize.mock.calls)).not.toContain("PRIVATE RAW DESCRIPTION");
    expect(result).toEqual({ categoryCode: "food", confidence: 0.79, needsReview: true });
    expect(await database.get<{ method: string; review: number }>(
      "SELECT method, needs_review AS review FROM category_assignments WHERE ledger_entry_id = 'expense'",
    )).toEqual({ method: "openai_codex", review: 1 });
  });

  it("rejects non-expense entries before invoking OpenAI", async () => {
    await database.run("UPDATE ledger_entries SET direction = 'credit', amount_minor = 1000, entry_kind = 'unclassified' WHERE id = 'expense'");
    const categorize = vi.fn(async () => ({ categoryCode: "food", confidence: 1 }));
    const service = new CategorizationApplicationService(database, { categorize });

    await expect(service.categorizeWithOpenAI("expense", "SYNTHETIC CAFE")).rejects.toThrow("OPENAI_ENTRY_NOT_ELIGIBLE");
    expect(categorize).not.toHaveBeenCalled();
  });

  it("creates a user's expense category atomically, reuses its normalized name, and never calls AI", async () => {
    const categorize = vi.fn();
    const service = new CategorizationApplicationService(database, { categorize });
    const first = await service.assignCustom("expense", "  SYNTHETIC   Сімейні  ");
    const second = await service.assignCustom("expense", "synthetic сімейні");
    expect(second.categoryCode).toBe(first.categoryCode);
    expect(await database.get("SELECT display_name,scope FROM categories WHERE code=?",[first.categoryCode])).toEqual({display_name:"SYNTHETIC Сімейні",scope:"personal"});
    expect(await database.get("SELECT count(*) AS n FROM category_assignments WHERE ledger_entry_id='expense' AND method='manual'")).toEqual({n:1});
    expect(categorize).not.toHaveBeenCalled();
    await expect(service.assignCustom("expense", "   ")).rejects.toThrow("CATEGORY_NAME_INVALID");
    await database.run("UPDATE ledger_entries SET entry_kind='transfer_out' WHERE id='expense'");
    await expect(service.assignCustom("expense", "SYNTHETIC Transfer")).rejects.toThrow("CATEGORY_ENTRY_NOT_ELIGIBLE");
  });

  it("rolls back both a custom category and its assignment if audit persistence fails", async () => {
    const service = new CategorizationApplicationService(database, { categorize: vi.fn() });
    const before = await database.get("SELECT count(*) AS n FROM categories");
    await database.exec("CREATE TRIGGER reject_custom_audit BEFORE INSERT ON audit_events WHEN NEW.event_code = 'CUSTOM_CATEGORY_ASSIGNED' BEGIN SELECT RAISE(ABORT, 'SYNTHETIC_REJECT'); END");
    await expect(service.assignCustom("expense", "SYNTHETIC rollback")).rejects.toThrow();
    expect(await database.get("SELECT count(*) AS n FROM categories")).toEqual(before);
    expect(await database.get("SELECT count(*) AS n FROM category_assignments")).toEqual({n:0});
  });

  it("can explicitly accept a low-confidence assignment without rerunning the model", async () => {
    const service = new CategorizationApplicationService(database, { categorize: async () => ({ categoryCode: "food", confidence: 0.75 }) });
    await service.categorizeWithOpenAI("expense", "SYNTHETIC CAFE");

    await service.acceptLatest("expense");

    expect(await database.get<{ review: number }>(
      "SELECT needs_review AS review FROM category_assignments WHERE ledger_entry_id = 'expense' ORDER BY rowid DESC LIMIT 1",
    )).toEqual({ review: 0 });
  });

  it("rolls back acceptance when its audit event cannot be recorded", async () => {
    const service = new CategorizationApplicationService(database, { categorize: async () => ({ categoryCode: "food", confidence: 0.75 }) });
    await service.categorizeWithOpenAI("expense", "SYNTHETIC CAFE");
    await database.exec(`
      CREATE TRIGGER synthetic_reject_category_audit
      BEFORE INSERT ON audit_events
      WHEN NEW.event_code = 'CATEGORY_ASSIGNMENT_ACCEPTED'
      BEGIN
        SELECT RAISE(ABORT, 'synthetic audit failure');
      END;
    `);

    await expect(service.acceptLatest("expense")).rejects.toThrow();

    expect(await database.get<{ review: number }>(
      "SELECT needs_review AS review FROM category_assignments WHERE ledger_entry_id = 'expense' ORDER BY rowid DESC LIMIT 1",
    )).toEqual({ review: 1 });
  });
});

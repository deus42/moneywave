import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openEncryptedDatabase, type EncryptedDatabase } from "@/server/db/database";
import { applyMigrations } from "@/server/db/migrations";
import { EntryClassificationService } from "@/server/categorization/entry-classification";

describe("deterministic entry classification", () => {
  let directory: string;
  let database: EncryptedDatabase;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "moneywave-classification-"));
    database = await openEncryptedDatabase(join(directory, "moneywave.db"), Buffer.alloc(32, 81));
    await applyMigrations(database);
    await database.run("INSERT INTO providers (id, code, display_name) VALUES ('provider-synthetic', 'privatbank', 'Synthetic')");
    await database.run("INSERT INTO accounts (id, provider_id, owner_scope, account_type, currency, display_name, identifier_hmac) VALUES ('fop', 'provider-synthetic', 'SOLE_PROPRIETOR', 'business', 'UAH', 'FOP', ?)", ["a".repeat(64)]);
    await database.run("INSERT INTO accounts (id, provider_id, owner_scope, account_type, currency, display_name, identifier_hmac) VALUES ('personal', 'provider-synthetic', 'PERSONAL', 'card', 'UAH', 'Personal', ?)", ["b".repeat(64)]);
  });

  afterEach(async () => {
    await database.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });

  async function entry(id: string, accountId: string, amount: bigint, description: string): Promise<void> {
    await database.run(
      "INSERT INTO ledger_entries (id, account_id, amount_minor, currency, direction, occurred_at, entry_kind, private_description) VALUES (?, ?, CAST(? AS INTEGER), 'UAH', ?, '2099-01-01T10:00:00', 'unclassified', ?)",
      [id, accountId, amount.toString(), amount < 0n ? "debit" : "credit", description],
    );
  }

  it("classifies FOP income, taxes, and terminal personal spend deterministically", async () => {
    await entry("income", "fop", 100_000n, "SYNTHETIC INCOME");
    await entry("tax", "fop", -10_000n, "SYNTHETIC TAX PAYMENT");
    await entry("purchase", "personal", -2_000n, "SYNTHETIC SHOP");

    const result = await new EntryClassificationService(database).refresh();

    expect(result).toEqual({ classified: 3, heldForReview: 0 });
    expect(await database.all<{ id: string; kind: string }>(
      "SELECT id, entry_kind AS kind FROM ledger_entries ORDER BY id",
    )).toEqual([
      { id: "income", kind: "business_income" },
      { id: "purchase", kind: "terminal_personal_expense" },
      { id: "tax", kind: "tax" },
    ]);
  });

  it("keeps a merchant payment with currency conversion in terminal spending", async () => {
    await entry("converted-purchase", "personal", -2_000n, "СИНТЕТИЧНА ОПЛАТА З ПОДВІЙНОЮ КОНВЕРТАЦІЄЮ");

    await new EntryClassificationService(database).refresh();

    expect(await database.get<{ kind: string }>("SELECT entry_kind AS kind FROM ledger_entries WHERE id = 'converted-purchase'"))
      .toEqual({ kind: "terminal_personal_expense" });
  });

  it("separates own movements from terminal external transfers while leaving pending candidates untouched", async () => {
    await entry("own-transfer", "personal", -2_000n, "SYNTHETIC TRANSFER BETWEEN CARDS");
    await entry("external-transfer", "personal", -2_100n, "SYNTHETIC TRANSFER TO RECIPIENT");
    await entry("wise-transfer", "personal", -2_150n, "SYNTHETIC WISE CARD LOAD");
    await entry("mobile-top-up", "personal", -2_200n, "SYNTHETIC MOBILE TOP UP");
    await entry("fx-credit", "fop", 4_000n, "SYNTHETIC Гривнi вiд продажу USD");
    await entry("external-fop-credit", "fop", 5_000n, "SYNTHETIC TRANSFER FROM CLIENT");
    await entry("candidate-debit", "personal", -3_000n, "SYNTHETIC SHOP");
    await entry("candidate-credit", "fop", 3_000n, "SYNTHETIC RECEIPT");
    await database.run(
      "INSERT INTO movement_candidates (id, debit_entry_id, credit_entry_id, match_kind) VALUES (?, ?, ?, 'exact')",
      [randomUUID(), "candidate-debit", "candidate-credit"],
    );

    const result = await new EntryClassificationService(database).refresh();

    expect(result).toEqual({ classified: 6, heldForReview: 2 });
    expect(await database.all<{ id: string; kind: string }>("SELECT id, entry_kind AS kind FROM ledger_entries ORDER BY id"))
      .toEqual([
        { id: "candidate-credit", kind: "unclassified" },
        { id: "candidate-debit", kind: "unclassified" },
        { id: "external-fop-credit", kind: "business_income" },
        { id: "external-transfer", kind: "terminal_personal_expense" },
        { id: "fx-credit", kind: "unlinked_transfer_in" },
        { id: "mobile-top-up", kind: "terminal_personal_expense" },
        { id: "own-transfer", kind: "unlinked_transfer_out" },
        { id: "wise-transfer", kind: "unlinked_transfer_out" },
      ]);
  });
});

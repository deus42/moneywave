import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createVerifiedBackup, restoreVerifiedBackup, verifyEncryptedBackup } from "@/server/db/backup";
import { openEncryptedDatabase } from "@/server/db/database";
import { applyMigrations, CURRENT_SCHEMA_VERSION, REQUIRED_TABLES } from "@/server/db/migrations";

describe("encrypted database", () => {
  let directory: string;
  const key = Buffer.alloc(32, 11);

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "moneywave-db-test-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("creates a SQLCipher database, applies numbered migrations, and rejects a wrong key", async () => {
    const databasePath = join(directory, "moneywave.db");
    const database = await openEncryptedDatabase(databasePath, key);
    expect(await database.get<{ cipher_version: string }>("PRAGMA cipher_version")).toMatchObject({ cipher_version: expect.any(String) });
    const result = await applyMigrations(database);
    expect(result).toMatchObject({ fromVersion: 0, toVersion: CURRENT_SCHEMA_VERSION });
    const tables = await database.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'");
    for (const table of REQUIRED_TABLES) expect(tables.map(({ name }) => name)).toContain(table);
    await database.close();

    const header = (await readFile(databasePath)).subarray(0, 16).toString("utf8");
    expect(header).not.toBe("SQLite format 3\u0000");
    await expect(openEncryptedDatabase(databasePath, Buffer.alloc(32, 12))).rejects.toThrow("DB_KEY_REJECTED");
  });

  it("seeds the editable two-level personal spending taxonomy", async () => {
    const database = await openEncryptedDatabase(join(directory, "moneywave.db"), key);
    await applyMigrations(database);

    const categories = await database.all<{ code: string; parentCode: string | null; displayName: string }>(`
      SELECT child.code, parent.code AS parentCode, child.display_name AS displayName
      FROM categories child
      LEFT JOIN categories parent ON parent.id = child.parent_id
      WHERE child.scope = 'personal'
      ORDER BY child.code
    `);

    expect(categories).toEqual(expect.arrayContaining([
      { code: "groceries", parentCode: "food", displayName: "Продукти" },
      { code: "dining", parentCode: "food", displayName: "Кафе й ресторани" },
      { code: "utilities", parentCode: "housing", displayName: "Комунальні та звʼязок" },
      { code: "p2p", parentCode: null, displayName: "Перекази людям" },
      { code: "taxi", parentCode: "transport", displayName: "Таксі" },
      { code: "streaming", parentCode: "entertainment", displayName: "Стримінг" },
      { code: "transfers", parentCode: null, displayName: "Перекази" },
    ]));
    await database.close();
  });

  it("creates constrained storage for provider fees, reporting valuations, category aliases, and cash openings", async () => {
    const database = await openEncryptedDatabase(join(directory, "moneywave.db"), key);
    await applyMigrations(database);

    await database.run("INSERT INTO providers (id, code, display_name) VALUES (?, ?, ?)", ["provider-synth", "synthetic", "Synthetic Provider"]);
    await database.run(
      "INSERT INTO accounts (id, provider_id, owner_scope, account_type, currency, display_name, identifier_hmac) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["account-synth", "provider-synth", "PERSONAL", "cash", "UAH", "Synthetic cash", "c".repeat(64)],
    );
    await database.run(
      "INSERT INTO ledger_entries (id, account_id, amount_minor, currency, direction, occurred_at, entry_kind) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["entry-synth", "account-synth", -1_050, "UAH", "debit", "2099-01-02T00:00:00", "terminal_personal_expense"],
    );
    await database.run(
      "INSERT INTO balance_snapshots (id, account_id, balance_minor, currency, observed_at, evidence_kind) VALUES (?, ?, ?, ?, ?, ?)",
      ["balance-synth", "account-synth", 9_000, "UAH", "2099-01-02T00:00:00", "manual"],
    );
    await database.run(
      "INSERT INTO import_artifacts (id, sha256, encrypted_bytes, size_bytes, parser_kind, parser_version) VALUES (?, ?, ?, ?, ?, ?)",
      ["artifact-synth", "d".repeat(64), Buffer.from("SYNTHETIC"), 9, "synthetic", "1"],
    );
    await database.run(
      "INSERT INTO import_batches (id, artifact_id, status, row_count) VALUES (?, ?, ?, ?)",
      ["batch-synth", "artifact-synth", "committed", 1],
    );
    await database.run(
      "INSERT INTO source_records (id, batch_id, source_row_number, dedupe_fingerprint, row_state) VALUES (?, ?, ?, ?, ?)",
      ["source-synth", "batch-synth", 1, "e".repeat(64), "posted"],
    );
    await database.run(
      "INSERT INTO transaction_evidence (id, ledger_entry_id, source_record_id, observed_amount_minor, observed_currency, observed_direction) VALUES (?, ?, ?, ?, ?, ?)",
      ["evidence-synth", "entry-synth", "source-synth", -1_050, "UAH", "debit"],
    );

    await database.run(
      "INSERT INTO provider_fee_evidence (id, transaction_evidence_id, amount_minor, currency, included_in_settlement) VALUES (?, ?, ?, ?, ?)",
      ["fee-synth", "evidence-synth", 50, "UAH", 1],
    );
    await database.run(
      "INSERT INTO ledger_entry_valuations (ledger_entry_id, source_currency, target_currency, converted_amount_minor, requested_date, rate_text, source, publication_date, formula_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["entry-synth", "UAH", "EUR", -24, "2099-01-02", "0.023", "NBU", "2099-01-02", "daily-v1"],
    );
    await database.run(
      "INSERT INTO balance_snapshot_valuations (balance_snapshot_id, source_currency, target_currency, converted_amount_minor, requested_date, rate_text, source, publication_date, formula_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["balance-synth", "UAH", "USD", 220, "2099-01-02", "0.0244", "NBU", "2099-01-02", "daily-v1"],
    );
    await database.run(
      "INSERT INTO category_aliases (id, provider_code, normalized_alias, category_id, priority) VALUES (?, ?, ?, ?, ?)",
      ["alias-synth", "synthetic", "synthetic market", "personal-groceries", 100],
    );
    await database.run(
      "INSERT INTO cash_opening_balances (account_id, opening_date, balance_minor, currency, evidence_kind) VALUES (?, ?, ?, ?, ?)",
      ["account-synth", "2099-01-01", 0, "UAH", "user_asserted"],
    );

    expect(await database.get<{ amount: string; included: number }>(
      "SELECT CAST(amount_minor AS TEXT) AS amount, included_in_settlement AS included FROM provider_fee_evidence",
    )).toEqual({ amount: "50", included: 1 });
    expect(await database.get<{ amount: string; source: string }>(
      "SELECT CAST(converted_amount_minor AS TEXT) AS amount, source FROM ledger_entry_valuations",
    )).toEqual({ amount: "-24", source: "NBU" });
    expect(await database.get<{ opening: string; kind: string }>(
      "SELECT CAST(balance_minor AS TEXT) AS opening, evidence_kind AS kind FROM cash_opening_balances",
    )).toEqual({ opening: "0", kind: "user_asserted" });
    await expect(database.run(
      "INSERT INTO provider_fee_evidence (id, transaction_evidence_id, amount_minor, currency, included_in_settlement) VALUES (?, ?, ?, ?, ?)",
      ["fee-invalid", "evidence-synth", -1, "UAH", 1],
    )).rejects.toThrow();
    await expect(database.run(
      "INSERT INTO category_aliases (id, provider_code, normalized_alias, category_id, priority) VALUES (?, ?, ?, ?, ?)",
      ["alias-duplicate", "synthetic", "synthetic market", "personal-groceries", 1],
    )).rejects.toThrow();

    await database.close();
  });

  it("round-trips signed 64-bit minor units without JavaScript number conversion", async () => {
    const database = await openEncryptedDatabase(join(directory, "moneywave.db"), key);
    await applyMigrations(database);
    await database.run("INSERT INTO providers (id, code, display_name) VALUES (?, ?, ?)", ["provider-synth", "synthetic", "Synthetic Provider"]);
    await database.run(
      "INSERT INTO accounts (id, provider_id, owner_scope, account_type, currency, display_name, identifier_hmac) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["account-synth", "provider-synth", "PERSONAL", "card", "UAH", "Synthetic account", "a".repeat(64)],
    );
    const amount = 9_000_000_000_000_001n;
    await database.run(
      "INSERT INTO ledger_entries (id, account_id, amount_minor, currency, direction, occurred_at, entry_kind) VALUES (?, ?, CAST(? AS INTEGER), ?, ?, ?, ?)",
      ["entry-synth", "account-synth", amount.toString(), "UAH", "credit", "2099-01-01T00:00:00", "business_income"],
    );
    const row = await database.get<{ amount_minor_text: string }>(
      "SELECT CAST(amount_minor AS TEXT) AS amount_minor_text FROM ledger_entries WHERE id = ?",
      ["entry-synth"],
    );
    expect(BigInt(row?.amount_minor_text ?? "0")).toBe(amount);
    await database.close();
  });

  it("creates an encrypted, checksummed, integrity-checked backup and verifies a restore copy", async () => {
    const databasePath = join(directory, "moneywave.db");
    const backupPath = join(directory, "backups", "synthetic.backup");
    const database = await openEncryptedDatabase(databasePath, key);
    await applyMigrations(database);
    await database.run("INSERT INTO providers (id, code, display_name) VALUES (?, ?, ?)", ["provider-synth", "synthetic", "Synthetic Provider"]);

    const manifest = await createVerifiedBackup({ database, destinationPath: backupPath, key, reason: "after_import" });
    expect(manifest.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.integrity).toBe("ok");
    expect((await stat(backupPath)).mode & 0o777).toBe(0o600);
    expect((await readFile(backupPath)).subarray(0, 16).toString("utf8")).not.toBe("SQLite format 3\u0000");
    await expect(verifyEncryptedBackup(backupPath, Buffer.alloc(32, 13))).rejects.toThrow("BACKUP_KEY_REJECTED");
    await database.close();

    const restoredPath = join(directory, "restored.db");
    const restored = await restoreVerifiedBackup({ backupPath, destinationPath: restoredPath, key });
    expect(restored.integrity).toBe("ok");
    const restoredDatabase = await openEncryptedDatabase(restoredPath, key);
    expect(await restoredDatabase.get<{ code: string }>("SELECT code FROM providers WHERE id = ?", ["provider-synth"])).toEqual({ code: "synthetic" });
    await restoredDatabase.close();
  });
});

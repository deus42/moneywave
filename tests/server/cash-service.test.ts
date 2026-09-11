import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openEncryptedDatabase, type EncryptedDatabase } from "@/server/db/database";
import { applyMigrations } from "@/server/db/migrations";
import { CashService } from "@/server/cash/service";

describe("cash accounting", () => {
  let directory: string;
  let database: EncryptedDatabase;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "moneywave-cash-test-"));
    database = await openEncryptedDatabase(join(directory, "moneywave.db"), Buffer.alloc(32, 62));
    await applyMigrations(database);
    await database.run("INSERT INTO providers (id, code, display_name) VALUES ('provider-bank', 'synthetic', 'Synthetic Bank')");
    await database.run(
      "INSERT INTO accounts (id, provider_id, owner_scope, account_type, currency, display_name, identifier_hmac) VALUES ('bank-uah', 'provider-bank', 'PERSONAL', 'card', 'UAH', 'Synthetic UAH', ?)",
      ["a".repeat(64)],
    );
    await database.run(
      "INSERT INTO import_artifacts (id, sha256, encrypted_bytes, size_bytes, parser_kind, parser_version) VALUES ('artifact', ?, ?, 9, 'synthetic', '1')",
      ["b".repeat(64), Buffer.from("SYNTHETIC")],
    );
    await database.run("INSERT INTO import_batches (id, artifact_id, status, row_count) VALUES ('batch', 'artifact', 'committed', 2)");
  });

  afterEach(async () => {
    await database.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });

  async function bankEntry(id: string, row: number, amountMinor: bigint, metadata: Record<string, string>): Promise<void> {
    const sourceId = `source-${id}`;
    await database.run(
      "INSERT INTO source_records (id, batch_id, source_row_number, dedupe_fingerprint, row_state, source_metadata_json) VALUES (?, 'batch', ?, ?, 'posted', ?)",
      [sourceId, row, String(row).repeat(64).slice(0, 64), JSON.stringify(metadata)],
    );
    await database.run(
      "INSERT INTO ledger_entries (id, account_id, amount_minor, currency, direction, occurred_at, entry_kind, private_description) VALUES (?, 'bank-uah', CAST(? AS INTEGER), 'UAH', ?, '2099-01-02T10:00:00', 'unclassified', ?)",
      [id, amountMinor.toString(), amountMinor < 0n ? "debit" : "credit", metadata.description ?? "SYNTHETIC"],
    );
    await database.run(
      "INSERT INTO transaction_evidence (id, ledger_entry_id, source_record_id, observed_amount_minor, observed_currency, observed_direction) VALUES (?, ?, ?, CAST(? AS INTEGER), 'UAH', ?)",
      [`evidence-${id}`, id, sourceId, amountMinor.toString(), amountMinor < 0n ? "debit" : "credit"],
    );
  }

  it("starts UAH/EUR/USD cash at zero and creates only evidence-backed cash movements", async () => {
    await bankEntry("withdrawal", 1, -10_000n, { mcc: "6011", description: "SYNTHETIC ATM" });
    await bankEntry("cash-shop", 2, -2_000n, { mcc: "5411", description: "SYNTHETIC CASH SHOP" });
    await bankEntry("teller-withdrawal", 3, -5_000n, { sourceCategory: "Зняття готівки", description: "SYNTHETIC BANK DESK" });
    await database.run(
      "INSERT INTO category_assignments (id, ledger_entry_id, category_id, method, classification_version) VALUES ('cash-category', 'teller-withdrawal', 'personal-cash', 'bank', 'canonical-v2')",
    );
    const service = new CashService(database);

    expect(await service.run({ openingDate: "2099-01-01", currencies: ["UAH", "EUR", "USD"] })).toEqual({
      accountsInitialized: 3,
      movementsCreated: 2,
    });
    expect(await database.all<{ currency: string; opening: string }>(`
      SELECT currency, CAST(balance_minor AS TEXT) AS opening
      FROM cash_opening_balances
      ORDER BY currency
    `)).toEqual([
      { currency: "EUR", opening: "0" },
      { currency: "UAH", opening: "0" },
      { currency: "USD", opening: "0" },
    ]);
    expect(await database.get<{ amount: string; count: number }>(`
      SELECT CAST(SUM(amount_minor) AS TEXT) AS amount, COUNT(*) AS count
      FROM ledger_entries
      WHERE account_id = 'cash-uah' AND amount_minor <> 0
    `)).toEqual({ amount: "15000", count: 2 });
    expect(await database.get<{ balance: string; observedAt: string }>(`
      SELECT CAST(balance_minor AS TEXT) AS balance, observed_at AS observedAt
      FROM balance_snapshots
      WHERE id = 'cash-derived-snapshot-uah'
    `)).toEqual({ balance: "15000", observedAt: "2099-01-02T10:00:00" });
    expect(await database.get<{ status: string; kind: string }>(
      "SELECT reconciliation_status AS status, entry_kind AS kind FROM ledger_entries WHERE id = 'withdrawal'",
    )).toEqual({ status: "reconciled", kind: "transfer_out" });
    expect(await database.get<{ kind: string }>(
      "SELECT entry_kind AS kind FROM ledger_entries WHERE id = 'cash-shop'",
    )).toEqual({ kind: "unclassified" });
    expect(await database.get<{ count: number }>(
      "SELECT count(*) AS count FROM category_assignments WHERE ledger_entry_id = 'teller-withdrawal'",
    )).toEqual({ count: 0 });
    expect(await service.run({ openingDate: "2099-01-01", currencies: ["UAH", "EUR", "USD"] })).toEqual({
      accountsInitialized: 0,
      movementsCreated: 0,
    });
  });
});

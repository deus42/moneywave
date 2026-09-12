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

  async function sourceAmount(id: string, amount: string | null, currency: string | null): Promise<void> {
    await database.run("UPDATE transaction_evidence SET source_amount_minor=CAST(? AS INTEGER), source_currency=? WHERE ledger_entry_id=?", [amount, currency, id]);
  }

  it.each([
    { bank: -48_000n, source: "1200", cash: "1200", description: "SYNTHETIC ATM" },
    { bank: 48_000n, source: "1200", cash: "-1200", description: "SYNTHETIC cash deposit" },
  ])("uses the original operation amount and currency for $description", async ({ bank, source, cash, description }) => {
    await bankEntry("foreign", 1, bank, { description });
    await sourceAmount("foreign", source, "EUR");
    const service = new CashService(database);
    // Only the cash currency needs to be enabled; the bank account currency is independent.
    await service.run({ openingDate: "2099-01-01", currencies: ["EUR"] });
    expect(await database.get("SELECT CAST(amount_minor AS TEXT) AS amount, currency FROM ledger_entries WHERE account_id='cash-eur'"))
      .toEqual({ amount: cash, currency: "EUR" });
    expect(await database.get("SELECT CAST(amount_minor AS TEXT) AS amount, currency FROM ledger_entries WHERE id='foreign'"))
      .toEqual({ amount: bank.toString(), currency: "UAH" });
  });

  it.each([[null, "EUR"], ["1200", null], ["0", "EUR"]])("rejects incomplete or zero original cash evidence (%s, %s)", async (amount, currency) => {
    await bankEntry("invalid", 1, -48_000n, { description: "SYNTHETIC ATM" });
    await sourceAmount("invalid", amount, currency);
    await expect(new CashService(database).run({ openingDate: "2099-01-01", currencies: ["UAH", "EUR"] }))
      .rejects.toThrow("CASH_SOURCE_EVIDENCE_INVALID");
    expect(await database.get("SELECT COUNT(*) AS count FROM movement_groups")).toEqual({ count: 0 });
  });

  it("rejects conflicting original operation evidence", async () => {
    await bankEntry("conflict", 1, -48_000n, { description: "SYNTHETIC ATM" });
    await bankEntry("extra", 2, -48_000n, { description: "SYNTHETIC" });
    await sourceAmount("conflict", "1200", "EUR");
    await sourceAmount("extra", "1300", "EUR");
    await database.run("UPDATE transaction_evidence SET ledger_entry_id='conflict' WHERE ledger_entry_id='extra'");
    await expect(new CashService(database).run({ openingDate: "2099-01-01", currencies: ["UAH", "EUR"] }))
      .rejects.toThrow("CASH_SOURCE_EVIDENCE_CONFLICT");
  });

  it("repairs an audited derived cash leg, clears stale valuations and is idempotent", async () => {
    await bankEntry("legacy", 1, -48_000n, { description: "SYNTHETIC ATM" });
    const service = new CashService(database);
    await service.run({ openingDate: "2099-01-01", currencies: ["UAH", "EUR"] });
    await sourceAmount("legacy", "1200", "EUR");
    const before = await database.get<{ id: string }>("SELECT id FROM ledger_entries WHERE account_id='cash-uah'");
    const bankBefore = await database.get("SELECT * FROM ledger_entries WHERE id='legacy'");
    await database.run(`INSERT INTO category_assignments (id,ledger_entry_id,category_id,method,classification_version)
      VALUES ('automatic-cash-category',?,'personal-cash','deterministic','synthetic')`, [before!.id]);
    await database.run(`INSERT INTO ledger_entry_valuations
      (ledger_entry_id,source_currency,target_currency,converted_amount_minor,requested_date,rate_text,source,publication_date,formula_version)
      VALUES (?, 'UAH','UAH',48000,'2099-01-02','1','identity','2099-01-02','synthetic')`, [before!.id]);
    await database.run(`INSERT INTO balance_snapshot_valuations
      (balance_snapshot_id,source_currency,target_currency,converted_amount_minor,requested_date,rate_text,source,publication_date,formula_version)
      VALUES ('cash-derived-snapshot-uah','UAH','UAH',48000,'2099-01-02','1','identity','2099-01-02','synthetic')`);
    expect(await service.repairDerivedMovements(["legacy"])).toEqual({ movementsCorrected: 1 });
    expect(await database.get("SELECT account_id AS account, CAST(amount_minor AS TEXT) AS amount, currency FROM ledger_entries WHERE id=?", [before!.id]))
      .toEqual({ account: "cash-eur", amount: "1200", currency: "EUR" });
    expect(await database.get("SELECT * FROM ledger_entries WHERE id='legacy'")).toEqual(bankBefore);
    expect(await database.get("SELECT COUNT(*) AS count FROM category_assignments WHERE id='automatic-cash-category'"))
      .toEqual({ count: 1 });
    expect(await database.all("SELECT currency,CAST(balance_minor AS TEXT) AS amount FROM balance_snapshots WHERE id LIKE 'cash-derived-%' ORDER BY currency"))
      .toEqual([{ currency: "EUR", amount: "1200" }, { currency: "UAH", amount: "0" }]);
    expect(await database.get("SELECT COUNT(*) AS count FROM ledger_entry_valuations")).toEqual({ count: 0 });
    expect(await database.get("SELECT COUNT(*) AS count FROM balance_snapshot_valuations")).toEqual({ count: 0 });
    expect(await service.repairDerivedMovements(["legacy"])).toEqual({ movementsCorrected: 0 });
    expect(await service.run({ openingDate: "2099-01-01", currencies: ["UAH", "EUR"] })).toEqual({ accountsInitialized: 0, movementsCreated: 0 });
    expect(await database.get("SELECT COUNT(*) AS count FROM audit_events WHERE event_code='CASH_SOURCE_AMOUNT_CORRECTED'"))
      .toEqual({ count: 1 });
  });

  it("rolls back repair when a requested leg is not an audited cash derivation", async () => {
    await bankEntry("legacy", 1, -48_000n, { description: "SYNTHETIC ATM" });
    const service = new CashService(database);
    await service.run({ openingDate: "2099-01-01", currencies: ["UAH", "EUR"] });
    await sourceAmount("legacy", "1200", "EUR");
    const before = await database.all("SELECT * FROM ledger_entries ORDER BY id");
    await expect(service.repairDerivedMovements(["legacy", "missing"])).rejects.toThrow("CASH_REPAIR_UNSAFE");
    expect(await database.all("SELECT * FROM ledger_entries ORDER BY id")).toEqual(before);
  });

  it.each(["manual-cost", "missing-audit", "manual-category"])("preserves a protected movement (%s)", async reason => {
    await bankEntry("protected", 1, -48_000n, { description: "SYNTHETIC ATM" });
    const service = new CashService(database);
    await service.run({ openingDate: "2099-01-01", currencies: ["UAH", "EUR"] });
    await sourceAmount("protected", "1200", "EUR");
    if (reason === "missing-audit") await database.run("DELETE FROM audit_events WHERE event_code='CASH_MOVEMENT_DERIVED'");
    else if (reason === "manual-category") await database.run(`INSERT INTO category_assignments (id,ledger_entry_id,category_id,method,classification_version)
      SELECT 'protected-category',id,'personal-cash','manual','synthetic' FROM ledger_entries WHERE account_id='cash-uah'`);
    else await database.run(`INSERT INTO cost_components (id,movement_group_id,method,amount_minor,currency,estimated)
      SELECT 'protected-cost',movement_group_id,'manual_cost',100,'UAH',0 FROM movement_legs WHERE ledger_entry_id='protected'`);
    const before = await database.all("SELECT * FROM ledger_entries ORDER BY id");
    await expect(service.repairDerivedMovements(["protected"])).rejects.toThrow("CASH_REPAIR_UNSAFE");
    expect(await database.all("SELECT * FROM ledger_entries ORDER BY id")).toEqual(before);
  });

  it("requires an initialized target cash account for repair", async () => {
    await bankEntry("legacy", 1, -48_000n, { description: "SYNTHETIC ATM" });
    const service = new CashService(database);
    await service.run({ openingDate: "2099-01-01", currencies: ["UAH"] });
    await sourceAmount("legacy", "1200", "EUR");
    await expect(service.repairDerivedMovements(["legacy"])).rejects.toThrow("CASH_REPAIR_TARGET_UNAVAILABLE");
    expect(await database.get("SELECT COUNT(*) AS count FROM ledger_entries WHERE account_id='cash-uah'"))
      .toEqual({ count: 1 });
  });

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

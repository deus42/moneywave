import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openEncryptedDatabase, type EncryptedDatabase } from "@/server/db/database";
import { applyMigrations } from "@/server/db/migrations";
import { CostService } from "@/server/movements/cost-service";

describe("movement cost persistence", () => {
  let directory: string;
  let database: EncryptedDatabase;
  let service: CostService;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "moneywave-cost-service-"));
    database = await openEncryptedDatabase(join(directory, "moneywave.db"), Buffer.alloc(32, 61));
    await applyMigrations(database);
    service = new CostService(database);
    await database.run("INSERT INTO providers (id, code, display_name) VALUES ('provider-synthetic', 'synthetic', 'Synthetic')");
    for (const [id, currency, hash] of [
      ["source-uah", "UAH", "a".repeat(64)],
      ["destination-uah", "UAH", "b".repeat(64)],
      ["source-usd", "USD", "c".repeat(64)],
    ] as const) {
      await database.run(
        "INSERT INTO accounts (id, provider_id, owner_scope, account_type, currency, display_name, identifier_hmac) VALUES (?, 'provider-synthetic', 'PERSONAL', 'synthetic', ?, ?, ?)",
        [id, currency, `Synthetic ${id}`, hash],
      );
    }
  });

  afterEach(async () => {
    await database.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });

  async function group(input: {
    debitId: string;
    creditId: string;
    debitAccount: string;
    creditAccount: string;
    debitMinor: bigint;
    creditMinor: bigint;
    debitCurrency: string;
    creditCurrency: string;
  }): Promise<string> {
    const groupId = randomUUID();
    await database.run("INSERT INTO movement_groups (id, status, evidence_kind) VALUES (?, 'confirmed', 'manual')", [groupId]);
    await database.run(
      "INSERT INTO ledger_entries (id, account_id, amount_minor, currency, direction, occurred_at, entry_kind) VALUES (?, ?, CAST(? AS INTEGER), ?, 'debit', '2099-01-01T10:00:00', 'transfer_out')",
      [input.debitId, input.debitAccount, input.debitMinor.toString(), input.debitCurrency],
    );
    await database.run(
      "INSERT INTO ledger_entries (id, account_id, amount_minor, currency, direction, occurred_at, entry_kind) VALUES (?, ?, CAST(? AS INTEGER), ?, 'credit', '2099-01-01T10:00:00', 'transfer_in')",
      [input.creditId, input.creditAccount, input.creditMinor.toString(), input.creditCurrency],
    );
    await database.run(
      "INSERT INTO movement_legs (id, movement_group_id, ledger_entry_id, leg_kind, position) VALUES (?, ?, ?, 'transfer_out', 0), (?, ?, ?, 'transfer_in', 1)",
      [randomUUID(), groupId, input.debitId, randomUUID(), groupId, input.creditId],
    );
    return groupId;
  }

  it("persists user-confirmed costs separately from statement fees before marking reconciliation complete", async () => {
    const groupId = await group({
      debitId: "entry-debit", creditId: "entry-credit", debitAccount: "source-uah", creditAccount: "destination-uah",
      debitMinor: -10_000n, creditMinor: 9_800n, debitCurrency: "UAH", creditCurrency: "UAH",
    });
    const result = await service.reconcileSameCurrency(groupId, { manualCostsMajor: ["1.00"], confirmResidualAsTransferGap: true });

    expect(result).toMatchObject({ reconciled: true, observedGapMinor: 100n });
    expect(await database.get<{ status: string }>("SELECT status FROM movement_groups WHERE id = ?", [groupId])).toEqual({ status: "reconciled" });
    expect(await database.all<{ method: string }>("SELECT method FROM cost_components WHERE movement_group_id = ? ORDER BY rowid", [groupId]))
      .toEqual([{ method: "manual_cost" }, { method: "same_currency_transfer_gap" }]);
  });

  it("persists an unexplained gap but refuses reconciled status", async () => {
    const groupId = await group({
      debitId: "entry-debit", creditId: "entry-credit", debitAccount: "source-uah", creditAccount: "destination-uah",
      debitMinor: -10_000n, creditMinor: 9_900n, debitCurrency: "UAH", creditCurrency: "UAH",
    });
    const result = await service.reconcileSameCurrency(groupId, { manualCostsMajor: [], confirmResidualAsTransferGap: false });
    expect(result.reconciled).toBe(false);
    expect(await database.get<{ status: string }>("SELECT status FROM movement_groups WHERE id = ?", [groupId])).toEqual({ status: "confirmed" });
    expect(await database.get<{ method: string }>("SELECT method FROM cost_components WHERE movement_group_id = ?", [groupId])).toEqual({ method: "unexplained_gap" });
  });

  it("includes a separate statement-fee debit on the source side before subtracting it as an explicit cost", async () => {
    const groupId = await group({
      debitId: "entry-debit", creditId: "entry-credit", debitAccount: "source-uah", creditAccount: "destination-uah",
      debitMinor: -10_000n, creditMinor: 9_800n, debitCurrency: "UAH", creditCurrency: "UAH",
    });
    await database.run(
      "INSERT INTO ledger_entries (id, account_id, amount_minor, currency, direction, occurred_at, entry_kind) VALUES ('entry-fee', 'source-uah', -100, 'UAH', 'debit', '2099-01-01T10:00:00', 'explicit_fee')",
    );
    await database.run(
      "INSERT INTO movement_legs (id, movement_group_id, ledger_entry_id, leg_kind, position) VALUES (?, ?, 'entry-fee', 'explicit_fee', 2)",
      [randomUUID(), groupId],
    );

    const result = await service.reconcileSameCurrency(groupId, { manualCostsMajor: [], confirmResidualAsTransferGap: true });

    expect(result).toMatchObject({ reconciled: true, observedGapMinor: 200n });
    expect(result.components).toEqual([
      { method: "explicit_statement_fee", amountMinor: 100n, currency: "UAH", estimated: false },
      { method: "same_currency_transfer_gap", amountMinor: 200n, currency: "UAH", estimated: false },
    ]);
  });

  it("stores reproducible FX evidence and avoids double-counting a manual cost", async () => {
    const groupId = await group({
      debitId: "entry-debit", creditId: "entry-credit", debitAccount: "source-usd", creditAccount: "destination-uah",
      debitMinor: -10_000n, creditMinor: 400_000n, debitCurrency: "USD", creditCurrency: "UAH",
    });
    const result = await service.reconcileFx(groupId, {
      benchmarkRate: "40.50",
      benchmarkSource: "NBU",
      publicationDate: "2099-01-01",
      manualCostMajor: "20.00",
    });
    expect(result).toMatchObject({ totalFxCostMinor: 5_000n, reconciled: true });
    expect(await database.all<{ method: string; amount: string }>(
      "SELECT method, CAST(amount_minor AS TEXT) AS amount FROM cost_components WHERE movement_group_id = ? ORDER BY rowid",
      [groupId],
    )).toEqual([
      { method: "manual_cost", amount: "2000" },
      { method: "fx_spread_estimate", amount: "3000" },
    ]);
    expect(await database.get<{ benchmark: string; publicationDate: string }>(
      "SELECT benchmark_source AS benchmark, benchmark_publication_date AS publicationDate FROM fx_conversions WHERE movement_group_id = ?",
      [groupId],
    )).toEqual({ benchmark: "NBU", publicationDate: "2099-01-01" });
  });
});

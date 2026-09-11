import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openEncryptedDatabase, type EncryptedDatabase } from "@/server/db/database";
import { applyMigrations } from "@/server/db/migrations";
import { AutonomousCostService } from "@/server/movements/autonomous-cost-service";

describe("autonomous cost analysis", () => {
  let directory: string;
  let database: EncryptedDatabase;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "moneywave-auto-cost-"));
    database = await openEncryptedDatabase(join(directory, "moneywave.db"), Buffer.alloc(32, 83));
    await applyMigrations(database);
    await database.run("INSERT INTO providers (id, code, display_name) VALUES ('provider', 'synthetic', 'Synthetic')");
    for (const [id, currency, hash] of [
      ["usd", "USD", "a".repeat(64)],
      ["uah-one", "UAH", "b".repeat(64)],
      ["uah-two", "UAH", "c".repeat(64)],
    ] as const) {
      await database.run(
        "INSERT INTO accounts (id, provider_id, owner_scope, account_type, currency, display_name, identifier_hmac) VALUES (?, 'provider', 'PERSONAL', 'synthetic', ?, ?, ?)",
        [id, currency, id, hash],
      );
    }
  });

  afterEach(async () => {
    await database.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });

  async function movement(input: {
    id: string;
    debitAccount: string;
    creditAccount: string;
    debitMinor: bigint;
    creditMinor: bigint;
    debitCurrency: string;
    creditCurrency: string;
  }): Promise<void> {
    await database.run("INSERT INTO movement_groups (id, status, evidence_kind) VALUES (?, 'confirmed', 'automatic_exact')", [input.id]);
    const debitId = `${input.id}-debit`;
    const creditId = `${input.id}-credit`;
    await database.run(
      "INSERT INTO ledger_entries (id, account_id, amount_minor, currency, direction, occurred_at, entry_kind) VALUES (?, ?, CAST(? AS INTEGER), ?, 'debit', '2099-01-02T10:00:00.000Z', 'transfer_out')",
      [debitId, input.debitAccount, input.debitMinor.toString(), input.debitCurrency],
    );
    await database.run(
      "INSERT INTO ledger_entries (id, account_id, amount_minor, currency, direction, occurred_at, entry_kind) VALUES (?, ?, CAST(? AS INTEGER), ?, 'credit', '2099-01-02T10:01:00.000Z', 'transfer_in')",
      [creditId, input.creditAccount, input.creditMinor.toString(), input.creditCurrency],
    );
    await database.run(
      "INSERT INTO movement_legs (id, movement_group_id, ledger_entry_id, leg_kind, position) VALUES (?, ?, ?, 'transfer_out', 0), (?, ?, ?, 'transfer_in', 1)",
      [randomUUID(), input.id, debitId, randomUUID(), input.id, creditId],
    );
  }

  it("adds an official benchmark to an already discovered FX conversion and is idempotent", async () => {
    await movement({ id: "fx", debitAccount: "usd", creditAccount: "uah-one", debitMinor: -10_000n, creditMinor: 400_000n, debitCurrency: "USD", creditCurrency: "UAH" });
    await database.run(
      "INSERT INTO fx_conversions (id, movement_group_id, sold_amount_minor, sold_currency, received_amount_minor, received_currency, executed_rate_text, formula_version) VALUES ('conversion', 'fx', 10000, 'USD', 400000, 'UAH', '40', 'executed_rate_v1')",
    );
    const benchmark = vi.fn(async () => ({ rate: "40.50", source: "NBU" as const, publicationDate: "2099-01-02" }));
    const service = new AutonomousCostService(database, { benchmark });

    expect(await service.run()).toEqual({ exactGroupsReconciled: 0, providerFeesRecorded: 0, fxBenchmarked: 1, fxBenchmarkUnavailable: 0 });
    expect(await database.get<{ source: string; formula: string }>(
      "SELECT benchmark_source AS source, formula_version AS formula FROM fx_conversions WHERE id = 'conversion'",
    )).toEqual({ source: "NBU", formula: "fx-cost@1" });
    expect(await database.get<{ method: string; amount: string }>(
      "SELECT method, CAST(amount_minor AS TEXT) AS amount FROM cost_components WHERE movement_group_id = 'fx'",
    )).toEqual({ method: "fx_spread_estimate", amount: "5000" });
    expect(await service.run()).toEqual({ exactGroupsReconciled: 0, providerFeesRecorded: 0, fxBenchmarked: 0, fxBenchmarkUnavailable: 0 });
  });

  it("marks an exact same-currency movement reconciled without inventing a cost", async () => {
    await movement({ id: "exact", debitAccount: "uah-one", creditAccount: "uah-two", debitMinor: -25_000n, creditMinor: 25_000n, debitCurrency: "UAH", creditCurrency: "UAH" });
    const service = new AutonomousCostService(database, { benchmark: vi.fn() });

    expect(await service.run()).toEqual({ exactGroupsReconciled: 1, providerFeesRecorded: 0, fxBenchmarked: 0, fxBenchmarkUnavailable: 0 });
    expect(await database.get<{ status: string }>("SELECT status FROM movement_groups WHERE id = 'exact'")).toEqual({ status: "reconciled" });
    expect(await database.get<{ count: number }>("SELECT count(*) AS count FROM cost_components")).toEqual({ count: 0 });
  });

  it("keeps an FX group confirmed when no official rate is available", async () => {
    await movement({ id: "fx", debitAccount: "usd", creditAccount: "uah-one", debitMinor: -10_000n, creditMinor: 400_000n, debitCurrency: "USD", creditCurrency: "UAH" });
    await database.run(
      "INSERT INTO fx_conversions (id, movement_group_id, sold_amount_minor, sold_currency, received_amount_minor, received_currency, executed_rate_text, formula_version) VALUES ('conversion', 'fx', 10000, 'USD', 400000, 'UAH', '40', 'executed_rate_v1')",
    );
    const service = new AutonomousCostService(database, { benchmark: async () => { throw new Error("FX_RATE_UNAVAILABLE"); } });

    expect(await service.run()).toEqual({ exactGroupsReconciled: 0, providerFeesRecorded: 0, fxBenchmarked: 0, fxBenchmarkUnavailable: 1 });
    expect(await database.get<{ status: string }>("SELECT status FROM movement_groups WHERE id = 'fx'")).toEqual({ status: "confirmed" });
    expect(await database.get<{ count: number }>("SELECT count(*) AS count FROM cost_components")).toEqual({ count: 0 });
  });

  it("uses a provider-stated fee to reconcile a transfer gap without double-debiting settlement", async () => {
    await movement({ id: "fee", debitAccount: "uah-one", creditAccount: "uah-two", debitMinor: -10_050n, creditMinor: 10_000n, debitCurrency: "UAH", creditCurrency: "UAH" });
    await database.run(
      "INSERT INTO import_artifacts (id, sha256, encrypted_bytes, size_bytes, parser_kind, parser_version) VALUES ('artifact-fee', ?, ?, 9, 'monobank_personal', '1')",
      ["f".repeat(64), Buffer.from("SYNTHETIC")],
    );
    await database.run("INSERT INTO import_batches (id, artifact_id, status, row_count) VALUES ('batch-fee', 'artifact-fee', 'committed', 1)");
    await database.run(
      "INSERT INTO source_records (id, batch_id, source_row_number, dedupe_fingerprint, row_state) VALUES ('source-fee', 'batch-fee', 1, ?, 'posted')",
      ["e".repeat(64)],
    );
    await database.run(
      "INSERT INTO transaction_evidence (id, ledger_entry_id, source_record_id, observed_amount_minor, observed_currency, observed_direction) VALUES ('evidence-fee', 'fee-debit', 'source-fee', -10050, 'UAH', 'debit')",
    );
    await database.run(
      "INSERT INTO provider_fee_evidence (id, transaction_evidence_id, amount_minor, currency, included_in_settlement) VALUES ('provider-fee', 'evidence-fee', 50, 'UAH', 1)",
    );
    const service = new AutonomousCostService(database, { benchmark: vi.fn() });

    expect(await service.run()).toEqual({ exactGroupsReconciled: 0, providerFeesRecorded: 1, fxBenchmarked: 0, fxBenchmarkUnavailable: 0 });
    expect(await database.get<{ status: string }>("SELECT status FROM movement_groups WHERE id = 'fee'")).toEqual({ status: "reconciled" });
    expect(await database.get<{ method: string; amount: string }>(
      "SELECT method, CAST(amount_minor AS TEXT) AS amount FROM cost_components WHERE movement_group_id = 'fee'",
    )).toEqual({ method: "explicit_statement_fee", amount: "50" });
    expect(await database.get<{ count: number }>("SELECT count(*) AS count FROM ledger_entries")).toEqual({ count: 2 });
    expect(await service.run()).toEqual({ exactGroupsReconciled: 0, providerFeesRecorded: 0, fxBenchmarked: 0, fxBenchmarkUnavailable: 0 });
  });
});

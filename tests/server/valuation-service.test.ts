import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openEncryptedDatabase, type EncryptedDatabase } from "@/server/db/database";
import { applyMigrations } from "@/server/db/migrations";
import type { ReportingRateResolver } from "@/server/fx/valuation-service";
import { ValuationService } from "@/server/fx/valuation-service";

function resolver(missingPair?: string): ReportingRateResolver {
  const rates: Record<string, string> = {
    "USD:UAH": "40",
    "USD:EUR": "0.8",
    "EUR:UAH": "50",
    "EUR:USD": "1.25",
    "UAH:EUR": "0.02",
    "UAH:USD": "0.025",
  };
  return {
    resolve: async (base, quote, requestedDate) => {
      if (base === quote) return { rate: "1", source: "identity", publicationDate: requestedDate };
      if (`${base}:${quote}` === missingPair) return null;
      const rate = rates[`${base}:${quote}`];
      return rate ? { rate, source: "NBU", publicationDate: "2099-01-01" } : null;
    },
  };
}

describe("reporting valuation materialization", () => {
  let directory: string;
  let database: EncryptedDatabase;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "moneywave-valuation-test-"));
    database = await openEncryptedDatabase(join(directory, "moneywave.db"), Buffer.alloc(32, 61));
    await applyMigrations(database);
    await database.run("INSERT INTO providers (id, code, display_name) VALUES (?, ?, ?)", ["provider-synth", "synthetic", "Synthetic"]);
    await database.run(
      "INSERT INTO accounts (id, provider_id, owner_scope, account_type, currency, display_name, identifier_hmac) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["account-usd", "provider-synth", "PERSONAL", "card", "USD", "Synthetic USD", "1".repeat(64)],
    );
    await database.run(
      "INSERT INTO ledger_entries (id, account_id, amount_minor, currency, direction, occurred_at, entry_kind) VALUES (?, ?, CAST(? AS INTEGER), ?, ?, ?, ?)",
      ["entry-usd", "account-usd", "-101", "USD", "debit", "2099-01-02T10:00:00", "terminal_personal_expense"],
    );
    await database.run(
      "INSERT INTO balance_snapshots (id, account_id, balance_minor, currency, observed_at, evidence_kind) VALUES (?, ?, CAST(? AS INTEGER), ?, ?, ?)",
      ["balance-usd", "account-usd", "101", "USD", "2099-01-02T10:00:00", "manual"],
    );
    await database.run("INSERT INTO movement_groups (id, status, evidence_kind) VALUES ('movement-usd', 'confirmed', 'synthetic')");
    await database.run("INSERT INTO movement_legs (id, movement_group_id, ledger_entry_id, leg_kind, position) VALUES ('leg-usd', 'movement-usd', 'entry-usd', 'transfer_out', 0)");
    await database.run("INSERT INTO cost_components (id, movement_group_id, method, amount_minor, currency, estimated) VALUES ('cost-usd', 'movement-usd', 'explicit_statement_fee', 101, 'USD', 0)");
    await database.run("INSERT INTO fx_conversions (id, movement_group_id, sold_amount_minor, sold_currency, received_amount_minor, received_currency, executed_rate_text, formula_version) VALUES ('fx-usd', 'movement-usd', 101, 'USD', 4040, 'UAH', '40', 'synthetic-v1')");
  });

  afterEach(async () => {
    await database.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });

  it("materializes UAH, EUR, and USD values with decimal half-up rounding and audit evidence", async () => {
    const service = new ValuationService(database, resolver());
    expect(await service.materialize({ fromDate: "2099-01-01", toDate: "2099-01-03" })).toEqual({
      entryValuations: 3,
      balanceValuations: 3,
      costValuations: 3,
      fxSourceValuations: 3,
      missingRates: [],
    });

    expect(await database.all<{
      target: string;
      amount: string;
      rate: string;
      source: string;
      publicationDate: string;
      formulaVersion: string;
    }>(`
      SELECT target_currency AS target, CAST(converted_amount_minor AS TEXT) AS amount,
        rate_text AS rate, source, publication_date AS publicationDate, formula_version AS formulaVersion
      FROM ledger_entry_valuations
      ORDER BY target_currency
    `)).toEqual([
      { target: "EUR", amount: "-81", rate: "0.8", source: "NBU", publicationDate: "2099-01-01", formulaVersion: "official-daily-v1" },
      { target: "UAH", amount: "-4040", rate: "40", source: "NBU", publicationDate: "2099-01-01", formulaVersion: "official-daily-v1" },
      { target: "USD", amount: "-101", rate: "1", source: "identity", publicationDate: "2099-01-02", formulaVersion: "official-daily-v1" },
    ]);

    await service.materialize({ fromDate: "2099-01-01", toDate: "2099-01-03" });
    expect(await database.get<{ count: number }>("SELECT count(*) AS count FROM ledger_entry_valuations")).toEqual({ count: 3 });
    expect(await database.get<{ count: number }>("SELECT count(*) AS count FROM balance_snapshot_valuations")).toEqual({ count: 3 });
    expect(await database.all<{ target: string; amount: string }>(
      "SELECT target_currency AS target, CAST(converted_amount_minor AS TEXT) AS amount FROM fx_conversion_source_valuations ORDER BY target_currency",
    )).toEqual([
      { target: "EUR", amount: "81" },
      { target: "UAH", amount: "4040" },
      { target: "USD", amount: "101" },
    ]);
    expect(await database.all<{ target: string; amount: string }>(
      "SELECT target_currency AS target, CAST(converted_amount_minor AS TEXT) AS amount FROM cost_component_valuations ORDER BY target_currency",
    )).toEqual([
      { target: "EUR", amount: "81" },
      { target: "UAH", amount: "4040" },
      { target: "USD", amount: "101" },
    ]);
  });

  it("records missing-rate coverage and never substitutes 1:1", async () => {
    const service = new ValuationService(database, resolver("USD:EUR"));
    const result = await service.materialize({ fromDate: "2099-01-01", toDate: "2099-01-03" });

    expect(result.missingRates).toEqual([
      { entityType: "balance_snapshot", sourceCurrency: "USD", targetCurrency: "EUR", requestedDate: "2099-01-02" },
      { entityType: "cost_component", sourceCurrency: "USD", targetCurrency: "EUR", requestedDate: "2099-01-02" },
      { entityType: "fx_conversion", sourceCurrency: "USD", targetCurrency: "EUR", requestedDate: "2099-01-02" },
      { entityType: "ledger_entry", sourceCurrency: "USD", targetCurrency: "EUR", requestedDate: "2099-01-02" },
    ]);
    expect(await database.get<{ count: number }>(
      "SELECT count(*) AS count FROM ledger_entry_valuations WHERE target_currency = 'EUR'",
    )).toEqual({ count: 0 });
  });

  it("refreshes only explicitly selected repair entities", async () => {
    const service = new ValuationService(database, resolver());
    await service.materialize({ fromDate: "2099-01-01", toDate: "2099-01-03" });
    const before = await database.all("SELECT * FROM balance_snapshot_valuations ORDER BY target_currency");
    const costs = await database.all("SELECT * FROM cost_component_valuations ORDER BY target_currency");
    const fx = await database.all("SELECT * FROM fx_conversion_source_valuations ORDER BY target_currency");
    await database.run("UPDATE ledger_entries SET amount_minor=-202 WHERE id='entry-usd'");
    expect(await service.materialize({ fromDate: "2099-01-01", toDate: "2099-01-03",
      scope: { ledgerEntryIds: ["entry-usd"], balanceSnapshotIds: [] } })).toEqual({
      entryValuations: 3, balanceValuations: 0, costValuations: 0, fxSourceValuations: 0, missingRates: [],
    });
    expect(await database.get("SELECT converted_amount_minor AS amount FROM ledger_entry_valuations WHERE target_currency='USD'"))
      .toEqual({ amount: -202 });
    expect(await database.all("SELECT * FROM balance_snapshot_valuations ORDER BY target_currency")).toEqual(before);
    expect(await database.all("SELECT * FROM cost_component_valuations ORDER BY target_currency")).toEqual(costs);
    expect(await database.all("SELECT * FROM fx_conversion_source_valuations ORDER BY target_currency")).toEqual(fx);
    expect(await service.materialize({ fromDate: "2099-01-01", toDate: "2099-01-03",
      scope: { ledgerEntryIds: [], balanceSnapshotIds: ["balance-usd"] } })).toMatchObject({
      entryValuations: 0, balanceValuations: 3, costValuations: 0, fxSourceValuations: 0,
    });
  });
});

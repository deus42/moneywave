import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openEncryptedDatabase, type EncryptedDatabase } from "@/server/db/database";
import { applyMigrations } from "@/server/db/migrations";
import { MoneyWaveReadRepository } from "@/server/read-model/repository";
import { FinanceExplorer } from "@/server/read-model/explorer";

let database: EncryptedDatabase;
let repository: MoneyWaveReadRepository;
let directory: string;

describe("read-only finance explorer", () => {
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "moneywave-explorer-synthetic-"));
    database = await openEncryptedDatabase(join(directory, "synthetic.db"), Buffer.alloc(32, 89));
    await applyMigrations(database);
    repository = new MoneyWaveReadRepository(database, () => new Date("2099-09-20T12:00:00Z"));
    await database.run("INSERT INTO providers (id,code,display_name) VALUES ('synthetic','synthetic','Synthetic Bank')");
    for (const id of ["source", "destination"]) await database.run("INSERT INTO accounts (id,provider_id,owner_scope,account_type,currency,display_name,identifier_hmac) VALUES (?, 'synthetic','PERSONAL','card','UAH',?,?)", [id, `Synthetic ${id}`, id.padEnd(64, "a")]);
  });
  afterEach(async () => { await database.close(); await rm(directory, { recursive: true, force: true }); });

  it("reads calendar months and legacy periods in every reporting currency without HTTP", async () => {
    await database.exec("PRAGMA query_only = ON");
    for (const period of ["2099-02", "30d", "90d", "12m", "24m", "all"] as const) for (const reportCurrency of ["UAH", "EUR", "USD"] as const) {
      expect(await repository.transactionPage({ period, reportCurrency })).toMatchObject({ total: 0, page: 1, items: [] });
    }
  });

  async function entry(id: string, amount: string, kind = "terminal_personal_expense", account = "source", date = "2099-01-01") {
    await database.run("INSERT INTO ledger_entries (id,account_id,amount_minor,currency,direction,occurred_at,entry_kind,private_description) VALUES (?,?,CAST(? AS INTEGER),'UAH',?,?,?,'SYNTHETIC ONLY')", [id, account, amount, amount.startsWith("-") ? "debit" : "credit", date, kind]);
  }
  async function valuation(id: string, amount: string) {
    await database.run("INSERT INTO ledger_entry_valuations (ledger_entry_id,source_currency,target_currency,converted_amount_minor,requested_date,rate_text,source,publication_date,formula_version) VALUES (?,'UAH','USD',CAST(? AS INTEGER),'2099-01-01','1','NBU','2099-01-01','official-daily-v1')", [id, amount]);
  }

  it("bounds monthly ledger, spending, income, routes and costs before aggregation and pagination", async () => {
    for (const [id, date, amount] of [["before", "2099-01-31T23:59:59", "-900"], ["first", "2099-02-01T00:00:00", "-101"], ["last", "2099-02-28T23:59:59", "-202"], ["after", "2099-03-01T00:00:00", "-700"]]) {
      await entry(id, amount, "terminal_personal_expense", "source", date);
      await valuation(id, amount);
    }
    for (const [id, date] of [["jan", "2099-01-31T23:59:59"], ["feb", "2099-02-10T12:00:00"], ["mar", "2099-03-01T00:00:00"]]) {
      await entry(`${id}-out`, "-100", "transfer_out", "source", date);
      await entry(`${id}-in`, "99", "transfer_in", "destination", date);
      await database.run("INSERT INTO movement_groups (id,status,evidence_kind) VALUES (?,'confirmed','same_reference')", [id]);
      for (const [suffix, kind, position] of [["out", "transfer_out", 0], ["in", "transfer_in", 1]] as const) await database.run("INSERT INTO movement_legs (id,movement_group_id,ledger_entry_id,leg_kind,position) VALUES (?,?,?,?,?)", [`${id}-${suffix}`, id, `${id}-${suffix}`, kind, position]);
      await database.run("INSERT INTO cost_components (id,movement_group_id,method,amount_minor,currency,estimated) VALUES (?,?,'same_currency_transfer_gap',1,'UAH',0)", [`cost-${id}`, id]);
    }
    await database.exec("PRAGMA query_only = ON");
    const period = "2099-02";
    expect(await repository.transactionPage({ period, mode: "expenses", pageSize: 1, sort: "oldest" })).toMatchObject({ total: 2, items: [{ id: "first" }] });
    expect(await repository.transactionPage({ period, mode: "expenses", pageSize: 1, page: 2, sort: "oldest" })).toMatchObject({ total: 2, items: [{ id: "last" }] });
    const overview = await repository.overview(period);
    expect(overview.transactionCount).toBe(4);
    expect(overview.flows).toEqual([expect.objectContaining({ spendingMinor: "303" })]);
    expect(overview.previousFlows).toEqual([expect.objectContaining({ spendingMinor: "900" })]);
    expect((await repository.categoryAnalytics(period)).terminalPersonalEntries).toBe(2);
    expect(await repository.categoryAnalytics(period, "USD")).toMatchObject({ terminalPersonalEntries: 2, totals: [{ amountMinor: "303", transactionCount: 2 }], trends: [{ month: "2099-02" }] });
    const flow = await repository.moneyFlow(period);
    expect(flow.transfers).toEqual([expect.objectContaining({ groupCount: 1, sourceAmountMinor: "100" })]);
    expect(flow.costs).toEqual([expect.objectContaining({ amountMinor: "1", componentCount: 1 })]);
    expect(await repository.movementPage({ period })).toMatchObject({ total: 1, items: [{ id: "feb" }] });
  });

  it("sorts exact reporting amounts before pagination, including int64 minimum and missing rates", async () => {
    for (const [id, amount, converted] of [
      ["largest", "-1", "-9223372036854775808"], ["next", "-1000", "-9223372036854775807"],
      ["smaller", "-5000", "-9007199254740993"], ["missing", "-9999", null],
    ]) { await entry(id!, amount!); if (converted) await valuation(id!, converted); }
    const first = await repository.transactionPage({ reportCurrency: "USD", sort: "largest", pageSize: 2 });
    expect(first.items.map((e) => e.id)).toEqual(["largest", "next"]);
    expect((await repository.transactionPage({ reportCurrency: "USD", sort: "largest", pageSize: 2, page: 2 })).items.map((e) => e.id)).toEqual(["smaller", "missing"]);
    expect((await repository.transactionPage({ sort: "oldest" })).items.map((e) => e.id)).toEqual(["largest", "missing", "next", "smaller"]);
  });

  it("uses canonical modes for both totals and page rows, excluding owner draws from income", async () => {
    await entry("expense", "-100"); await entry("income", "100", "business_income");
    await entry("draw", "-100", "owner_draw"); await entry("fx", "100", "fx_buy");
    await database.exec("PRAGMA query_only = ON");
    for (const [mode, id] of [["expenses", "expense"], ["income", "income"], ["transfers", "draw"], ["fx", "fx"]] as const) {
      expect(await repository.transactionPage({ period: "all", mode, sort: "oldest" })).toMatchObject({ total: 1, items: [expect.objectContaining({ id })] });
    }
  });

  it("paginates old movements, filters routes before pagination, and reads any movement by ID", async () => {
    for (let index = 0; index < 205; index++) {
      const id = `group-${String(index).padStart(3, "0")}`;
      await entry(`${id}-out`, "-100", "transfer_out");
      await entry(`${id}-in`, "100", "transfer_in", index === 204 ? "source" : "destination");
      await database.run("INSERT INTO movement_groups (id,status,evidence_kind) VALUES (?,'confirmed','same_reference')", [id]);
      for (const [suffix, kind, position] of [["out", "transfer_out", 0], ["in", "transfer_in", 1]] as const) await database.run("INSERT INTO movement_legs (id,movement_group_id,ledger_entry_id,leg_kind,position) VALUES (?,?,?,?,?)", [`${id}-${suffix}`, id, `${id}-${suffix}`, kind, position]);
    }
    await database.exec("PRAGMA query_only = ON");
    expect(await repository.movementPage({ period: "all", page: 5, pageSize: 50 })).toMatchObject({ total: 205, page: 5, pageCount: 5, items: expect.any(Array) });
    expect((await repository.movementPage({ period: "all", page: 5, pageSize: 50 })).items).toHaveLength(5);
    expect(await repository.movementById("group-204", "UAH")).toMatchObject({ id: "group-204", legs: [expect.objectContaining({ accountId: "source" }), expect.objectContaining({ accountId: "source" })] });
    expect(await repository.movementById("not-found", "UAH")).toBeNull();
    expect(await repository.movementPage({ route: { sourceAccountId: "source", destinationAccountId: "source", sourceCurrency: "UAH", destinationCurrency: "UAH" } })).toMatchObject({ total: 1, items: [expect.objectContaining({ id: "group-204" })] });
    expect((await repository.moneyFlow("all")).transfers).toEqual(expect.arrayContaining([expect.objectContaining({ sourceAccountId: "source", destinationAccountId: "destination", groupCount: 204 })]));
    expect(await repository.transactionById("group-204-out", "USD")).toMatchObject({ id: "group-204-out", valuationMissing: true });
  });

  it("reads addressed details directly without writes", async () => {
    await entry("detail-entry", "-100");
    await database.exec("PRAGMA query_only = ON");
    const explorer = new FinanceExplorer(database);
    expect(await explorer.details({ kind: "transaction", id: "detail-entry" }, "USD", "2025-08-31")).toMatchObject({ kind: "transaction", transaction: { id: "detail-entry", valuationMissing: true }, movement: null, sources: [] });
    expect(await explorer.details({ kind: "transaction", id: "unknown" }, "USD")).toBeNull();
    expect(await explorer.details({ kind: "account", id: "source" }, "USD", "2025-08-31")).toMatchObject({ kind: "account", position: { status: "missing_balance" }, transactions: { total: 0 } });
  });

  it("preserves manual month precision and shows history without inventing transactions", async () => {
    await database.run("INSERT INTO manual_workbooks (id,contract_version) VALUES ('synthetic-book','synthetic')");
    await database.run("INSERT INTO manual_position_series (id,lineage_id,label_key,display_name,provider_code,position_kind,currency) VALUES ('manual-synthetic','synthetic-book',?,'Synthetic manual','synthetic','bank','EUR')", ["a".repeat(64)]);
    for (const [id, period, amount] of [["one", "2099-01", 100], ["two", "2099-02", 200], ["future", "2099-04", 300]]) await database.run("INSERT INTO manual_position_facts (id,series_id,period,amount_minor) VALUES (?,'manual-synthetic',?,?)", [id, period, amount]);
    await database.exec("PRAGMA query_only = ON");
    const explorer = new FinanceExplorer(database, () => new Date("2099-03-15"));
    const detail = await explorer.details({ kind: "account", id: "manual:manual-synthetic" }, "EUR", "2099-03-15");
    expect(detail).toMatchObject({ kind: "account", position: { precision: "month", observedAt: "2099-02", nativeMinor: "200" }, transactions: null });
    if (detail?.kind !== "account") throw new Error("SYNTHETIC_DETAIL_MISSING");
    expect(detail.history.map((p) => [p.asOf, p.position.nativeMinor])).toEqual([["2099-01-31", "100"], ["2099-02-28", "200"]]);
    expect(await explorer.details({ kind: "account", id: "manual:manual-synthetic" }, "EUR", "2099-01-15")).toBeNull();
    expect(await database.get("SELECT count(*) AS count FROM ledger_entries")).toEqual({ count: 0 });
  });

  it("returns allowlisted source provenance, never raw metadata, identifiers or references", async () => {
    await entry("evidence-entry", "-100");
    await database.run("INSERT INTO import_artifacts (id,sha256,encrypted_bytes,size_bytes,parser_kind,parser_version) VALUES ('artifact',?,?,1,'synthetic','synthetic@1')", ["b".repeat(64), Buffer.from("SYNTHETIC_RAW_SECRET")]);
    await database.run("INSERT INTO import_batches (id,artifact_id,status,row_count) VALUES ('batch','artifact','committed',1)");
    await database.run("INSERT INTO source_records (id,batch_id,source_row_number,dedupe_fingerprint,row_state,source_metadata_json) VALUES ('record','batch',7,?,'posted',?)", ["c".repeat(64), JSON.stringify({ private: "SYNTHETIC_PII" })]);
    await database.run("INSERT INTO transaction_evidence (id,ledger_entry_id,source_record_id,observed_amount_minor,observed_currency,observed_direction,provider_reference) VALUES ('evidence','evidence-entry','record',-100,'UAH','debit','SYNTHETIC_REFERENCE')");
    await database.exec("PRAGMA query_only = ON");
    const result = await new FinanceExplorer(database).details({ kind: "transaction", id: "evidence-entry" }, "UAH");
    expect(result).toMatchObject({ kind: "transaction", sources: [{ id: "evidence", row: 7, parser: "synthetic", version: "synthetic@1", state: "posted", amountMinor: "-100", currency: "UAH", direction: "debit" }] });
    expect(JSON.stringify(result)).not.toMatch(/SYNTHETIC_RAW_SECRET|SYNTHETIC_PII|SYNTHETIC_REFERENCE|identifier_hmac/);
  });
});

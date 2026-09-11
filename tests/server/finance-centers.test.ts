import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openEncryptedDatabase, type EncryptedDatabase } from "@/server/db/database";
import { applyMigrations } from "@/server/db/migrations";
import { FinanceCenters } from "@/server/read-model/finance-centers";

describe("daily finance centers (independently synthetic)", () => {
  let directory: string;
  let database: EncryptedDatabase;
  let centers: FinanceCenters;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "moneywave-centers-"));
    database = await openEncryptedDatabase(join(directory, "synthetic.db"), Buffer.alloc(32, 41));
    await applyMigrations(database);
    centers = new FinanceCenters(database, () => new Date("2099-09-04T12:00:00Z"));
    await database.run("INSERT INTO providers VALUES ('synthetic', 'synthetic', 'Synthetic Bank')");
  });
  afterEach(async () => { await database?.close(); if (directory) await rm(directory, { recursive: true, force: true }); });
  async function account(id: string, currency = "UAH", type = "card", scope = "PERSONAL") {
    await database.run("INSERT INTO accounts (id, provider_id, owner_scope, account_type, currency, display_name) VALUES (?, 'synthetic', ?, ?, ?, ?)", [id, scope, type, currency, `Synthetic ${id}`]);
  }
  async function snapshot(id: string, accountId: string, value: string, date: string, currency = "UAH") {
    await database.run("INSERT INTO balance_snapshots (id, account_id, balance_minor, currency, observed_at, evidence_kind) VALUES (?, ?, CAST(? AS INTEGER), ?, ?, 'statement')", [id, accountId, value, currency, date]);
  }
  async function entry(id: string, amount: string, date: string, kind = "terminal_personal_expense", currency = "UAH", accountId = "card") {
    await database.run("INSERT INTO ledger_entries (id, account_id, amount_minor, currency, direction, occurred_at, entry_kind) VALUES (?, ?, CAST(? AS INTEGER), ?, ?, ?, ?)", [id, accountId, amount, currency, BigInt(amount) < 0n ? "debit" : "credit", date, kind]);
  }
  async function manual(id: string, accountId: string | null, amount: string, period = "2099-08", kind = "bank") {
    await database.run("INSERT OR IGNORE INTO manual_workbooks (id,contract_version) VALUES ('synthetic-workbook','1')");
    await database.run("INSERT OR IGNORE INTO manual_position_series (id,lineage_id,label_key,display_name,provider_code,position_kind,currency,account_id) VALUES (?,'synthetic-workbook',?,'Synthetic manual position','synthetic',?,'UAH',?)", [id, id.padEnd(64, "x"), kind, accountId]);
    await database.run("INSERT INTO manual_position_facts (id,series_id,period,amount_minor) VALUES (?,?,?,CAST(? AS INTEGER))", [`${id}-${period}-${amount}`, id, period, amount]);
  }
  it("includes distinct monthly positions only at their eligible boundary without inventing a day", async () => {
    await manual("manual", null, "12345");
    expect((await centers.capital("2099-08-30", "UAH")).positions).toHaveLength(0);
    const view = await centers.capital("2099-08-31", "UAH");
    expect(view.positions[0]).toMatchObject({ nativeMinor: "12345", observedAt: "2099-08", precision: "month", source: "manual_document", accountId: null });
    expect(view.knownNetMinor).toBe("12345");
    expect((await centers.capital("2099-09-01", "UAH")).positions[0].carriedForward).toBe(true);
  });
  it("coalesces linked monthly evidence with the bank and retains same-month statement authority", async () => {
    await account("card"); await snapshot("a", "card", "10000", "2099-08-15");
    await manual("manual", "card", "11000");
    const view = await centers.capital("2099-08-31", "UAH");
    expect(view.positions).toHaveLength(1);
    expect(view.knownNetMinor).toBe("10000");
    expect(view.positions[0]).toMatchObject({ source: "statement", manualEvidence: { period: "2099-08", amountMinor: "11000", comparison: "month_precision", differenceMinor: "1000" } });
  });
  it("uses a later manual month instead of an old bank balance, never adds both", async () => {
    await account("card"); await snapshot("a", "card", "10000", "2099-07-15");
    await manual("manual", "card", "11000");
    expect((await centers.capital("2099-08-31", "UAH")).knownNetMinor).toBe("11000");
  });
  it("excludes same-month manual value conflicts until a later observation supersedes them", async () => {
    await manual("manual", null, "10000", "2099-07"); await manual("manual", null, "11000", "2099-07");
    expect((await centers.capital("2099-07-31", "UAH")).positions[0]).toMatchObject({ status: "conflict", reportMinor: null });
    await manual("manual", null, "12000", "2099-08");
    expect((await centers.capital("2099-08-31", "UAH")).knownNetMinor).toBe("12000");
  });
  it("coalesces manual cash and only adds known movements after its monthly boundary", async () => {
    await account("cash", "UAH", "cash");
    await database.run("INSERT INTO cash_opening_balances (account_id,opening_date,balance_minor,currency,evidence_kind) VALUES ('cash','2099-07-01',0,'UAH','user_asserted')");
    await entry("before", "1000", "2099-08-15", "transfer_in", "UAH", "cash");
    await entry("after", "2000", "2099-09-01", "transfer_in", "UAH", "cash");
    await manual("manual-cash", "cash", "5000", "2099-08", "cash");
    const view = await centers.capital("2099-09-02", "UAH");
    expect(view.positions).toHaveLength(1);
    expect(view.positions[0]).toMatchObject({ nativeMinor: "7000", source: "manual_cash", manualEvidence: { comparison: "cash_record_gap", differenceMinor: "4000" } });
    expect(await database.get("SELECT COUNT(*) AS count FROM ledger_entries")).toEqual({ count: 2 });
  });
  it("monthly history uses the identical capital projection and no future evidence", async () => {
    await manual("manual", null, "10000", "2099-07"); await manual("manual", null, "12000", "2099-08");
    const history = await centers.capitalHistory("2099-08-31", "UAH");
    expect(history.at(-1)).toMatchObject({ asOf: "2099-08-31", knownMinor: "12000", manualCount: 1 });
    for (const point of history) expect(point.knownMinor).toBe((await centers.capital(point.asOf, "UAH")).knownNetMinor);
  });
  it("selects only snapshots on or before the stock date, not future evidence", async () => {
    await account("card");
    await snapshot("old", "card", "12000", "2099-07-31T12:00:00Z");
    await snapshot("new", "card", "20000", "2099-08-31T12:00:00Z");
    const view = await centers.capital("2099-08-01", "UAH");
    expect(view.positions[0]).toMatchObject({ nativeMinor: "12000", reportMinor: "12000", observedAt: "2099-07-31T12:00:00Z", carriedForward: true });
    expect(view.knownNetMinor).toBe("12000");
    expect(view.completeNetWorthMinor).toBeNull();
  });
  it("never turns FOP journal net movement into a balance or missing debt into zero", async () => {
    await account("fop", "USD", "business", "SOLE_PROPRIETOR");
    await entry("income", "12000", "2099-08-01T10:00:00Z", "business_income", "USD", "fop");
    const view = await centers.capital("2099-08-31", "USD");
    expect(view.positions[0]).toMatchObject({ nativeMinor: null, status: "missing_balance" });
    expect(view.unvaluedCount).toBe(1);
    expect(view.completeNetWorthMinor).toBeNull();
  });
  it("excludes conflicting latest observations instead of picking an arbitrary row", async () => {
    await account("card");
    await snapshot("a", "card", "100", "2099-08-31T12:00:00Z");
    await snapshot("b", "card", "200", "2099-08-31T12:00:00Z");
    expect((await centers.capital("2099-08-31", "UAH")).positions[0]).toMatchObject({ reportMinor: null, status: "conflict" });
  });
  it("keeps exact int64 values and separates evidenced negative bank positions", async () => {
    await account("card"); await account("debt");
    await snapshot("a", "card", "9007199254740993", "2099-08-31");
    await snapshot("b", "debt", "-250", "2099-08-31");
    const view = await centers.capital("2099-08-31", "UAH");
    expect(view.knownAssetsMinor).toBe("9007199254740993");
    expect(view.knownLiabilitiesMinor).toBe("250");
    expect(view.knownNetMinor).toBe("9007199254740743");
  });
  it("revalues native positions at the selected date and exposes stale publication", async () => {
    await account("card", "USD");
    await snapshot("a", "card", "105", "2099-07-31", "USD");
    await database.run("INSERT INTO fx_rate_cache (base_currency,quote_currency,requested_date,rate_text,source,publication_date) VALUES ('USD','UAH','2099-08-20','41.5','NBU','2099-08-20'), ('USD','UAH','2099-09-01','99','NBU','2099-09-01')");
    expect((await centers.capital("2099-08-31", "UAH")).positions[0]).toMatchObject({ nativeMinor: "105", reportMinor: "4358", rate: "41.5", publicationDate: "2099-08-20", rateStale: true });
  });
  it("never substitutes 1:1 for a missing stock valuation", async () => {
    await account("card", "EUR"); await snapshot("a", "card", "100", "2099-08-31", "EUR");
    expect((await centers.capital("2099-08-31", "USD")).positions[0]).toMatchObject({ nativeMinor: "100", reportMinor: null, status: "missing_rate" });
  });
  it("calculates cash from its asserted opening and bounded known movements", async () => {
    await account("cash", "UAH", "cash");
    await database.run("INSERT INTO cash_opening_balances (account_id, opening_date, balance_minor, currency, evidence_kind) VALUES ('cash','2099-08-01',0,'UAH','user_asserted')");
    await entry("cash-in", "9000", "2099-08-02", "transfer_in", "UAH", "cash");
    await entry("future", "1000", "2099-09-02", "transfer_in", "UAH", "cash");
    expect((await centers.capital("2099-08-31", "UAH")).positions[0]).toMatchObject({ nativeMinor: "9000", source: "calculated_cash" });
    await entry("cash-out", "-10000", "2099-08-03", "transfer_out", "UAH", "cash");
    expect((await centers.capital("2099-08-31", "UAH")).positions[0]).toMatchObject({ status: "conflict", reportMinor: null });
  });
  it("compares two calendar months independently of the historical explorer and excludes transfers", async () => {
    await account("card");
    await entry("old", "-10000", "2099-07-15");
    await entry("new", "-12500", "2099-08-15");
    await entry("transfer", "-90000", "2099-08-15", "owner_draw");
    await entry("future", "-50000", "2099-09-01");
    for (const id of ["old", "new"]) await database.run("INSERT INTO category_assignments (id,ledger_entry_id,category_id,method) VALUES (?,?,'personal-groceries','mcc')", [id, id]);
    const view = await centers.spending(undefined, "UAH");
    expect(view).toMatchObject({ month: "2099-08", previousMonth: "2099-07", currentMinor: "12500", previousMinor: "10000", deltaMinor: "2500", missingValuations: 0 });
    expect(view.categories).toHaveLength(1);
    expect(view.categories[0]).toMatchObject({ currentMinor: "12500", previousMinor: "10000" });
  });
  it("makes unvalued and uncategorized expenses visible and suppresses confident comparisons", async () => {
    await account("card");
    await entry("missing", "-1000", "2099-08-15", "terminal_personal_expense", "EUR");
    const view = await centers.spending("2099-08", "UAH");
    expect(view).toMatchObject({ missingValuations: 1, uncategorizedCount: 1, deltaMinor: null, previousMinor: null });
    expect(view.categories[0]).toMatchObject({ code: "uncategorized", missingValuations: 1 });
  });
  it("normalizes malformed or future date controls to safe non-future defaults", async () => {
    expect((await centers.capital("2099-02-31", "UAH")).asOf).toBe("2099-09-04");
    expect((await centers.capital("2100-01-01", "UAH")).asOf).toBe("2099-09-04");
    expect((await centers.spending("2100-01", "UAH")).month).toBe("2099-08");
  });
  it("keeps missing current and previous month valuations separate", async () => {
    await account("card");
    await entry("prior-unvalued", "-1000", "2099-07-15", "terminal_personal_expense", "EUR");
    await entry("current-known", "-2000", "2099-08-15");
    const first = await centers.spending("2099-08", "UAH");
    expect(first).toMatchObject({ currentMissingValuations:0, previousMissingValuations:1, previousCount:1, deltaMinor:null });
    expect(first.categories[0]).toMatchObject({ currentMissingValuations:0, currentMinor:"2000" });
    await entry("current-unvalued", "-3000", "2099-08-16", "terminal_personal_expense", "EUR");
    expect(await centers.spending("2099-08", "UAH")).toMatchObject({currentMissingValuations:1, previousMissingValuations:1});
  });
});

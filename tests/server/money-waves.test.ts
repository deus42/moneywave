import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openEncryptedDatabase, type EncryptedDatabase } from "@/server/db/database";
import { applyMigrations } from "@/server/db/migrations";
import { MoneyWavesReader } from "@/server/read-model/money-waves";

let db: EncryptedDatabase;
let directory: string;
const now = () => new Date("2099-09-20T12:00:00Z");
async function account(id: string, currency = "UAH", type = "card") {
  await db.run("INSERT INTO accounts (id,provider_id,owner_scope,account_type,currency,display_name,identifier_hmac) VALUES (?,'synthetic','PERSONAL',?,?,'Synthetic account',?)", [id, type, currency, id.padEnd(64, "z")]);
}
async function entry(id: string, accountId: string, amount: string, kind = "transfer_out", currency = "UAH", date = "2099-09-01") {
  await db.run("INSERT INTO ledger_entries (id,account_id,amount_minor,currency,direction,occurred_at,entry_kind,private_description) VALUES (?,?,CAST(? AS INTEGER),?,?,?,?,'SYNTHETIC_PRIVATE_DESCRIPTION')", [id, accountId, amount, currency, amount.startsWith("-") ? "debit" : "credit", date, kind]);
}
async function group(id: string, ids: string[], evidence = "same_reference", status = "confirmed") {
  await db.run("INSERT INTO movement_groups (id,status,evidence_kind) VALUES (?,?,?)", [id, status, evidence]);
  for (const [index, entryId] of ids.entries()) await db.run("INSERT INTO movement_legs (id,movement_group_id,ledger_entry_id,leg_kind,position) SELECT ?,?,id,entry_kind,? FROM ledger_entries WHERE id = ?", [`${id}-${index}`, id, index, entryId]);
}
async function cost(id: string, groupId: string, method: string, amount: string) {
  await db.run("INSERT INTO cost_components (id,movement_group_id,method,amount_minor,currency,estimated,audit_evidence_json) VALUES (?,?,?,CAST(? AS INTEGER),'UAH',?,'{}')", [id, groupId, method, amount, method === "fx_spread_estimate" ? 1 : 0]);
}
const read = async (currency: "UAH" | "EUR" | "USD" = "UAH", period: "all" | "24m" | "30d" = "all") => {
  await db.exec("PRAGMA query_only = ON");
  return new MoneyWavesReader(db, now).read(period, currency);
};

describe("Money Waves read-only projection", () => {
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "moneywave-map-synthetic-"));
    db = await openEncryptedDatabase(join(directory, "synthetic.db"), Buffer.alloc(32, 72));
    await applyMigrations(db);
    await db.run("INSERT INTO providers (id,code,display_name) VALUES ('synthetic','synthetic','Synthetic Bank')");
    await account("a"); await account("b"); await account("c");
  });
  afterEach(async () => { await db.close(); await rm(directory, { recursive: true, force: true }); });

  it("keeps account identity, aggregates every confirmed pair exactly, and excludes candidate links", async () => {
    for (const index of [1, 2]) {
      await entry(`d${index}`, "a", "-9007199254740993");
      await entry(`c${index}`, "b", "9007199254740993", "transfer_in");
      await group(`g${index}`, [`d${index}`, `c${index}`]);
    }
    await entry("candidate-d", "b", "-1"); await entry("candidate-c", "c", "1", "transfer_in");
    await group("candidate", ["candidate-d", "candidate-c"], "exact_amount", "candidate");
    const result = await read();
    expect(result.nodes.filter(n => n.kind === "account")).toHaveLength(3);
    expect(result.links.filter(l => l.kind === "transfer")).toEqual([expect.objectContaining({ from: "a", to: "b", count: 2, sent: expect.objectContaining({ reportMinor: "18014398509481986", missing: 0 }) })]);
    expect(result.links.some(l => l.from === "b" && l.to === "c")).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/SYNTHETIC_PRIVATE_DESCRIPTION|identifier_hmac|private_description/);
  });

  it("shows income once, personal refunds net of spending, and taxes separately from fees", async () => {
    await entry("income", "a", "10000", "business_income");
    await entry("draw-out", "a", "-8000", "owner_draw"); await entry("draw-in", "b", "8000", "transfer_in");
    await group("draw", ["draw-out", "draw-in"]);
    await entry("expense", "b", "-900", "terminal_personal_expense");
    await entry("refund", "b", "200", "terminal_personal_expense");
    await entry("tax", "a", "-1500", "tax"); await entry("fee", "a", "-10", "explicit_fee");
    const result = await read();
    expect(result.summary.income.reportMinor).toBe("10000");
    expect(result.summary.spending.reportMinor).toBe("700");
    expect(result.summary.taxes.reportMinor).toBe("1500");
    expect(result.summary.costs).toEqual([expect.objectContaining({ method: "explicit_statement_fee", amount: expect.objectContaining({ reportMinor: "10" }) })]);
    expect(result.nodes.find(n => n.id === "b")?.spending.reportMinor).toBe("700");
  });

  it("counts fee components once even when a fee ledger leg exists, keeping all cost methods distinct", async () => {
    await entry("debit", "a", "-1000"); await entry("credit", "b", "980", "transfer_in");
    await entry("fee", "a", "-10", "explicit_fee"); await group("g", ["debit", "credit", "fee"]);
    await cost("fee-cost", "g", "explicit_statement_fee", "10");
    await cost("gap-cost", "g", "unexplained_gap", "20");
    await cost("fx-cost", "g", "fx_spread_estimate", "30");
    const result = await read();
    expect(result.summary.costs.map(c => [c.method, c.amount.reportMinor])).toEqual(expect.arrayContaining([["explicit_statement_fee", "10"], ["unexplained_gap", "20"], ["fx_spread_estimate", "30"]]));
    expect(result.links).toHaveLength(1);
    expect(result.links[0]?.costs).toHaveLength(3);
  });

  it("does not invent pairwise attribution for a multi-leg movement", async () => {
    await entry("d", "a", "-1000"); await entry("c1", "b", "400", "transfer_in"); await entry("c2", "c", "600", "transfer_in");
    await group("multi", ["d", "c1", "c2"]); await cost("fee", "multi", "explicit_statement_fee", "5");
    const result = await read();
    const junction = result.nodes.find(n => n.kind === "junction");
    expect(junction).toBeDefined();
    expect(result.links).toHaveLength(3);
    expect(result.links.every(l => l.from === junction?.id || l.to === junction?.id)).toBe(true);
    expect(result.links.flatMap(l => l.costs)).toHaveLength(0);
    expect(junction?.costs[0]?.amount.reportMinor).toBe("5");
  });

  it("shows provider-described FX as a source pool, never as an invented owned debit", async () => {
    await entry("fx-in", "a", "4500", "fx_buy"); await group("fx", ["fx-in"], "provider_fx_description");
    await db.run("INSERT INTO fx_conversions (id,movement_group_id,sold_amount_minor,sold_currency,received_amount_minor,received_currency,executed_rate_text,formula_version) VALUES ('fx-row','fx',100,'USD',4500,'UAH','45','synthetic')");
    const result = await read();
    const pool = result.nodes.find(n => n.kind === "source_pool");
    expect(pool?.balance).toBeNull();
    expect(result.links).toEqual([expect.objectContaining({ from: pool?.id, to: "a", kind: "fx", sent: expect.objectContaining({ reportMinor: null, missing: 1, native: [{ currency: "USD", minor: "100" }] }) })]);
    expect(result.summary.income.count).toBe(0);
    expect(result.summary.fxWithoutEstimate).toBe(1);
  });

  it("keeps missing multi-source endpoints visible and attaches their costs only once", async () => {
    await entry("a-out", "a", "-400"); await entry("b-out", "b", "-600");
    await group("missing-multi", ["a-out", "b-out"]); await cost("fee", "missing-multi", "explicit_statement_fee", "5");
    const result = await read();
    expect(result.nodes.filter(n => n.kind === "junction")).toHaveLength(1);
    expect(result.nodes.filter(n => n.kind === "boundary")).toHaveLength(1);
    expect(result.links).toHaveLength(3);
    expect(result.links.flatMap(l => l.costs)).toHaveLength(0);
    expect(result.summary.incomplete).toBe(1);
  });

  it("keeps route identity stable across period changes and never reassigns focus by row index", async () => {
    await entry("a-old-d", "a", "-1", "transfer_out", "UAH", "2099-01-01");
    await entry("a-old-c", "b", "1", "transfer_in", "UAH", "2099-01-01");
    await group("old", ["a-old-d", "a-old-c"]);
    await entry("new-d", "b", "-2"); await entry("new-c", "c", "2", "transfer_in"); await group("new", ["new-d", "new-c"]);
    const all = await read(); const recent = await read("UAH", "30d");
    expect(all.links.find(l => l.from === "b")?.id).toBe(recent.links.find(l => l.from === "b")?.id);
  });

  it("uses transaction-day valuations, preserves missing coverage, and never guesses a 1:1 FX rate", async () => {
    await entry("one", "a", "-1000", "terminal_personal_expense");
    await entry("two", "a", "-2000", "terminal_personal_expense");
    await db.run("INSERT INTO ledger_entry_valuations (ledger_entry_id,source_currency,target_currency,converted_amount_minor,requested_date,rate_text,source,publication_date,formula_version) VALUES ('one','UAH','EUR',-20,'2099-09-01','0.02','NBU','2099-09-01','synthetic')");
    const result = await read("EUR");
    expect(result.summary.spending).toMatchObject({ reportMinor: "20", missing: 1, count: 2, native: [{ currency: "UAH", minor: "3000" }] });
    expect(result.summary.knownNetMinor).toBe("0");
    expect(result.summary.missingBalances).toBe(3);
  });

  it("keeps missing endpoints explicit, includes uncategorized expenses and omits future/undated rows", async () => {
    await entry("unlinked", "a", "-300");
    await entry("expense", "b", "-200", "terminal_personal_expense");
    await entry("future", "b", "-900", "terminal_personal_expense", "UAH", "2100-01-01");
    await entry("old", "b", "-900", "terminal_personal_expense", "UAH", "2090-01-01");
    const result = await read("UAH", "24m");
    expect(result.links).toEqual([expect.objectContaining({ from: "a", kind: "incomplete", received: expect.objectContaining({ reportMinor: null }) })]);
    expect(result.nodes.some(n => n.kind === "boundary")).toBe(true);
    expect(result.summary.spending.reportMinor).toBe("200");
    expect(result.summary.uncategorized).toBe(1);
  });

  it("retains manual-only balances without generating bank movements", async () => {
    await db.run("INSERT INTO manual_workbooks (id,contract_version) VALUES ('synthetic-book','synthetic')");
    await db.run("INSERT INTO manual_position_series (id,lineage_id,label_key,display_name,provider_code,position_kind,currency) VALUES ('manual-synthetic','synthetic-book',?,'Synthetic manual','synthetic','bank','UAH')", ["a".repeat(64)]);
    await db.run("INSERT INTO manual_position_facts (id,series_id,period,amount_minor) VALUES ('fact','manual-synthetic','2099-08',777)");
    const result = await read();
    expect(result.nodes.find(n => n.id === "manual:manual-synthetic")).toMatchObject({ balance: { nativeMinor: "777", precision: "month", observedAt: "2099-08" } });
    expect(result.links).toHaveLength(0);
  });

  it("discloses an old stock-valuation rate instead of implying a fresh quote", async () => {
    await entry("rate-evidence", "a", "-100", "terminal_personal_expense");
    await db.run("INSERT INTO ledger_entry_valuations (ledger_entry_id,source_currency,target_currency,converted_amount_minor,requested_date,rate_text,source,publication_date,formula_version) VALUES ('rate-evidence','UAH','USD',-2,'2099-01-01','0.02','NBU','2099-01-01','synthetic')");
    await db.run("INSERT INTO balance_snapshots (id,account_id,balance_minor,currency,observed_at,evidence_kind) VALUES ('balance','a',2500,'UAH','2099-09-18','statement')");
    const result = await read("USD");
    expect(result.nodes.find(n => n.id === "a")?.balance).toMatchObject({ reportMinor: "50", rateDate: "2099-01-01", rateStale: true });
  });

  it("does not treat a bank withdrawal as spending or reconcile cash without evidence", async () => {
    await account("cash", "UAH", "cash");
    await db.run("INSERT INTO cash_opening_balances (account_id,opening_date,balance_minor,currency,evidence_kind) VALUES ('cash','2099-01-01',0,'UAH','user_asserted')");
    await entry("bank-out", "a", "-500"); await entry("cash-in", "cash", "500", "transfer_in"); await group("cash-g", ["bank-out", "cash-in"]);
    const result = await read();
    expect(result.summary.spending.reportMinor).toBe("0");
    expect(result.nodes.find(n => n.id === "cash")).toMatchObject({ stage: 4, balance: { nativeMinor: "500", source: "calculated_cash" }, cash: { inflow: { reportMinor: "500" }, outflow: { reportMinor: "0" } } });
  });
});

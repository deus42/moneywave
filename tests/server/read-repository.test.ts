import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openEncryptedDatabase, type EncryptedDatabase } from "@/server/db/database";
import { applyMigrations } from "@/server/db/migrations";
import { MoneyWaveReadRepository } from "@/server/read-model/repository";

describe("MoneyWave read model", () => {
  let directory: string;
  let database: EncryptedDatabase;
  let repository: MoneyWaveReadRepository;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "moneywave-read-model-"));
    database = await openEncryptedDatabase(join(directory, "moneywave.db"), Buffer.alloc(32, 91));
    await applyMigrations(database);
    repository = new MoneyWaveReadRepository(database);
    await database.run("INSERT INTO providers (id, code, display_name) VALUES ('provider-synthetic', 'privatbank', 'Synthetic')");
    await database.run("INSERT INTO accounts (id, provider_id, owner_scope, account_type, currency, display_name, identifier_hmac, balance_evidence_status) VALUES ('fop-usd', 'provider-synthetic', 'SOLE_PROPRIETOR', 'business', 'USD', 'FOP USD', ?, 'statement')", ["a".repeat(64)]);
    await database.run("INSERT INTO accounts (id, provider_id, owner_scope, account_type, currency, display_name, identifier_hmac, balance_evidence_status) VALUES ('fop-uah', 'provider-synthetic', 'SOLE_PROPRIETOR', 'business', 'UAH', 'FOP UAH', ?, 'unavailable')", ["c".repeat(64)]);
    await database.run("INSERT INTO accounts (id, provider_id, owner_scope, account_type, currency, display_name, identifier_hmac, balance_evidence_status) VALUES ('personal-uah', 'provider-synthetic', 'PERSONAL', 'card', 'UAH', 'Personal UAH', ?, 'statement')", ["b".repeat(64)]);
  });

  afterEach(async () => {
    await database.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });

  it("filters cost drill-down before limiting the movement list", async () => {
    for (const [id, method, date] of [["older-fee", "explicit_statement_fee", "2099-01-01"], ["newer-gap", "unexplained_gap", "2099-01-02"]]) {
      await addEntry({ id: id!, accountId: "personal-uah", amount: -100n, currency: "UAH", kind: "transfer_out", description: "SYNTHETIC", occurredAt: date });
      await database.run("INSERT INTO movement_groups (id,status,evidence_kind) VALUES (?, 'confirmed', 'same_reference')", [id!]);
      await database.run("INSERT INTO movement_legs (id,movement_group_id,ledger_entry_id,leg_kind,position) VALUES (?, ?, ?, 'transfer_out', 0)", [id!, id!, id!]);
      await database.run("INSERT INTO cost_components (id,movement_group_id,method,amount_minor,currency,estimated) VALUES (?, ?, ?, 10, 'UAH', 0)", [id!, id!, method!]);
    }
    const rows = await repository.movementChains("all", 1, undefined, "explicit_statement_fee");
    expect(rows.map((row) => row.id)).toEqual(["older-fee"]);
    expect(await repository.movementChains("all", 1, undefined, "' OR 1=1 --")).toEqual([]);
  });

  it("keeps uncategorized expense drill-down scoped to terminal personal expenses", async () => {
    await addEntry({ id: "uncategorized", accountId: "personal-uah", amount: -100n, currency: "UAH", kind: "terminal_personal_expense", description: "SYNTHETIC" });
    await addEntry({ id: "transfer", accountId: "personal-uah", amount: -100n, currency: "UAH", kind: "transfer_out", description: "SYNTHETIC" });
    expect(await repository.transactionPage({ categoryCode: "uncategorized" })).toMatchObject({ total: 1, items: [expect.objectContaining({ id: "uncategorized" })] });
  });

  it("keeps uncategorized and unvalued expenses visible in reporting categories", async () => {
    await addEntry({ id: "desk-local", accountId: "personal-uah", amount: -345n, currency: "UAH", kind: "terminal_personal_expense", description: "SYNTHETIC UNASSIGNED" });
    await addEntry({ id: "desk-foreign", accountId: "personal-uah", amount: -200n, currency: "EUR", kind: "terminal_personal_expense", description: "SYNTHETIC MISSING RATE" });
    const view = await repository.categoryAnalytics("all", "UAH");
    expect(view.totals).toEqual([expect.objectContaining({ categoryCode: "uncategorized", amountMinor: "345", transactionCount: 2, missingValuationCount: 1 })]);
    expect(view.missingValuationCount).toBe(1);
  });

  it("searches Ukrainian case-insensitively and treats wildcard punctuation literally before pagination", async () => {
    await addEntry({ id: "uk-search", accountId: "personal-uah", amount: -100n, currency: "UAH", kind: "terminal_personal_expense", description: "SYNTHETIC Кава [тест] * 100%" });
    await addEntry({ id: "uk-other", accountId: "personal-uah", amount: -100n, currency: "UAH", kind: "terminal_personal_expense", description: "SYNTHETIC Інше" });
    for (const query of ["synthetic кава", "КАВА", "[тест]", "*", "100%"])
      expect(await repository.transactionPage({ query, pageSize: 1 })).toMatchObject({ total: 1, items: [expect.objectContaining({ id: "uk-search" })] });
  });

  async function addEntry(input: {
    id: string;
    accountId: string;
    amount: bigint;
    currency: string;
    kind: string;
    description: string;
    occurredAt?: string;
  }): Promise<void> {
    await database.run(
      "INSERT INTO ledger_entries (id, account_id, amount_minor, currency, direction, occurred_at, entry_kind, private_description) VALUES (?, ?, CAST(? AS INTEGER), ?, ?, ?, ?, ?)",
      [input.id, input.accountId, input.amount.toString(), input.currency, input.amount < 0n ? "debit" : "credit", input.occurredAt ?? "2099-01-01T10:00:00", input.kind, input.description],
    );
  }

  it("reports evidence balances and consolidated totals without double-counting internal movement", async () => {
    await addEntry({ id: "income", accountId: "fop-usd", amount: 100_000n, currency: "USD", kind: "business_income", description: "SYNTHETIC INCOME" });
    await addEntry({ id: "tax", accountId: "personal-uah", amount: -2_000n, currency: "UAH", kind: "tax", description: "SYNTHETIC TAX" });
    await addEntry({ id: "draw-out", accountId: "fop-usd", amount: -25_000n, currency: "USD", kind: "owner_draw", description: "SYNTHETIC DRAW" });
    await addEntry({ id: "draw-in", accountId: "personal-uah", amount: 25_000n, currency: "UAH", kind: "transfer_in", description: "SYNTHETIC DRAW" });
    await database.run("INSERT INTO balance_snapshots (id, account_id, balance_minor, currency, observed_at, evidence_kind) VALUES (?, 'personal-uah', 12345, 'UAH', '2099-01-01T11:00:00', 'statement')", [randomUUID()]);

    const overview = await repository.overview();

    expect(overview.accounts.find(({ id }) => id === "personal-uah")).toMatchObject({ balanceMinor: "12345", balanceEvidenceStatus: "statement" });
    expect(overview.flows).toEqual([
      { currency: "UAH", grossIncomeMinor: "0", spendingMinor: "2000", internalMovementMinor: "0" },
      { currency: "USD", grossIncomeMinor: "100000", spendingMinor: "0", internalMovementMinor: "25000" },
    ]);
  });

  it("returns bounded transactions with evidence counts and parameterized filters", async () => {
    await addEntry({ id: "visible", accountId: "personal-uah", amount: -2_000n, currency: "UAH", kind: "terminal_personal_expense", description: "SYNTHETIC MERCHANT" });
    await addEntry({ id: "hidden", accountId: "fop-usd", amount: 10_000n, currency: "USD", kind: "business_income", description: "SYNTHETIC OTHER" });

    const rows = await repository.transactions({ query: "merchant", accountId: "personal-uah", currency: "UAH", limit: 20 });

    expect(rows).toEqual([expect.objectContaining({ id: "visible", amountMinor: "-2000", evidenceCount: 0 })]);
    expect(await repository.transactions({ query: "%' OR 1=1 --", limit: 20 })).toEqual([]);
  });

  it("anchors rolling periods to today when the newest imported statement is stale", async () => {
    await addEntry({ id: "outside-window", accountId: "personal-uah", amount: -1_000n, currency: "UAH", kind: "terminal_personal_expense", description: "SYNTHETIC OLD", occurredAt: "2097-09-19T23:59:59Z" });
    await addEntry({ id: "inside-window", accountId: "personal-uah", amount: -2_000n, currency: "UAH", kind: "terminal_personal_expense", description: "SYNTHETIC BOUNDARY", occurredAt: "2097-09-20T00:00:00Z" });
    const todayAwareRepository = new MoneyWaveReadRepository(
      database,
      () => new Date("2099-09-20T12:00:00.000Z"),
    );

    expect(await todayAwareRepository.transactionPage({ period: "24m" })).toMatchObject({
      total: 1,
      items: [expect.objectContaining({ id: "inside-window" })],
    });
    expect((await todayAwareRepository.overview("24m")).anchorAt).toBe("2099-09-20T12:00:00.000Z");
  });

  it("converts every native currency into one report currency while preserving native drill-down values", async () => {
    await addEntry({ id: "usd-income", accountId: "fop-usd", amount: 10_000n, currency: "USD", kind: "business_income", description: "SYNTHETIC USD INCOME" });
    await addEntry({ id: "uah-spend", accountId: "personal-uah", amount: -20_000n, currency: "UAH", kind: "terminal_personal_expense", description: "SYNTHETIC UAH SPEND" });
    await addEntry({ id: "eur-missing", accountId: "personal-uah", amount: -3_000n, currency: "EUR", kind: "terminal_personal_expense", description: "SYNTHETIC EUR MISSING" });
    for (const [entryId, source, target, amount, rate, provider] of [
      ["usd-income", "USD", "UAH", "400000", "40", "NBU"],
      ["usd-income", "USD", "EUR", "9200", "0.92", "ECB"],
      ["usd-income", "USD", "USD", "10000", "1", "identity"],
      ["uah-spend", "UAH", "UAH", "-20000", "1", "identity"],
      ["uah-spend", "UAH", "EUR", "-460", "0.023", "NBU"],
      ["uah-spend", "UAH", "USD", "-500", "0.025", "NBU"],
    ] as const) {
      await database.run(`
        INSERT INTO ledger_entry_valuations (
          ledger_entry_id, source_currency, target_currency, converted_amount_minor,
          requested_date, rate_text, source, publication_date, formula_version
        ) VALUES (?, ?, ?, CAST(? AS INTEGER), '2099-01-01', ?, ?, '2099-01-01', 'official-daily-v1')
      `, [entryId, source, target, amount, rate, provider]);
    }
    await database.run(
      "INSERT INTO category_assignments (id, ledger_entry_id, category_id, method, needs_review) VALUES (?, 'uah-spend', 'personal-groceries', 'mcc', 0)",
      [randomUUID()],
    );

    const overview = await repository.overview("all", "UAH");
    expect(overview.flows).toEqual([{ currency: "UAH", grossIncomeMinor: "400000", spendingMinor: "20000", internalMovementMinor: "0" }]);
    expect(overview.timeline).toEqual([{ month: "2099-01", currency: "UAH", incomeMinor: "400000", spendingMinor: "20000" }]);
    expect(overview.missingValuationCount).toBe(1);

    const rows = await repository.transactions({ reportCurrency: "UAH" });
    expect(rows.map(({ id }) => id)).toEqual(["usd-income", "uah-spend", "eur-missing"]);
    expect(rows.find(({ id }) => id === "usd-income")).toMatchObject({
      amountMinor: "10000",
      currency: "USD",
      reportAmountMinor: "400000",
      reportCurrency: "UAH",
      valuationMissing: false,
      valuations: expect.arrayContaining([
        expect.objectContaining({ currency: "EUR", amountMinor: "9200", rate: "0.92", source: "ECB" }),
        expect.objectContaining({ currency: "UAH", amountMinor: "400000", rate: "40", source: "NBU" }),
        expect.objectContaining({ currency: "USD", amountMinor: "10000", rate: "1", source: "identity" }),
      ]),
    });
    expect(rows.find(({ id }) => id === "eur-missing")).toMatchObject({ reportAmountMinor: null, valuationMissing: true });
    expect((await repository.transactions({ reportCurrency: "UAH", nativeCurrency: "USD" })).map(({ id }) => id)).toEqual(["usd-income"]);

    const categories = await repository.categoryAnalytics("all", "UAH");
    expect(categories.totals).toEqual([
      expect.objectContaining({ categoryCode: "food", currency: "UAH", amountMinor: "20000", transactionCount: 1 }),
      expect.objectContaining({ categoryCode: "uncategorized", currency: "UAH", amountMinor: "0", transactionCount: 1, missingValuationCount: 1 }),
    ]);
  });

  it("converts the complete money-flow graph while retaining native route and cost evidence", async () => {
    await addEntry({ id: "flow-usd-out", accountId: "fop-usd", amount: -10_000n, currency: "USD", kind: "fx_sell", description: "SYNTHETIC FLOW OUT" });
    await addEntry({ id: "flow-uah-in", accountId: "personal-uah", amount: 400_000n, currency: "UAH", kind: "fx_buy", description: "SYNTHETIC FLOW IN" });
    await addEntry({ id: "flow-eur-spend", accountId: "personal-uah", amount: -1_000n, currency: "EUR", kind: "terminal_personal_expense", description: "SYNTHETIC EURO SPEND" });
    await addEntry({ id: "flow-usd-tax", accountId: "fop-usd", amount: -100n, currency: "USD", kind: "tax", description: "SYNTHETIC TAX" });
    await addEntry({ id: "flow-eur-unlinked", accountId: "personal-uah", amount: -500n, currency: "EUR", kind: "unlinked_transfer_out", description: "SYNTHETIC EXTERNAL" });
    await database.run("INSERT INTO category_assignments (id, ledger_entry_id, category_id, method, needs_review) VALUES (?, 'flow-eur-spend', 'personal-groceries', 'mcc', 0)", [randomUUID()]);
    await database.run("INSERT INTO movement_groups (id, status, evidence_kind) VALUES ('flow-group', 'reconciled', 'automatic_fx')");
    await database.run("INSERT INTO movement_legs (id, movement_group_id, ledger_entry_id, leg_kind, position) VALUES (?, 'flow-group', 'flow-usd-out', 'fx_sell', 0), (?, 'flow-group', 'flow-uah-in', 'fx_buy', 1)", [randomUUID(), randomUUID()]);
    await database.run("INSERT INTO cost_components (id, movement_group_id, method, amount_minor, currency, estimated) VALUES ('flow-cost', 'flow-group', 'fx_spread_estimate', 100, 'UAH', 1)");

    for (const [entryId, source, amount, rate, provider] of [
      ["flow-usd-out", "USD", "-400000", "40", "NBU"],
      ["flow-uah-in", "UAH", "400000", "1", "identity"],
      ["flow-eur-spend", "EUR", "-44000", "44", "NBU"],
      ["flow-usd-tax", "USD", "-4000", "40", "NBU"],
      ["flow-eur-unlinked", "EUR", "-22000", "44", "NBU"],
    ] as const) {
      await database.run(`
        INSERT INTO ledger_entry_valuations (
          ledger_entry_id, source_currency, target_currency, converted_amount_minor,
          requested_date, rate_text, source, publication_date, formula_version
        ) VALUES (?, ?, 'UAH', CAST(? AS INTEGER), '2099-01-01', ?, ?, '2099-01-01', 'official-daily-v1')
      `, [entryId, source, amount, rate, provider]);
    }
    await database.run(`
      INSERT INTO cost_component_valuations (
        cost_component_id, source_currency, target_currency, converted_amount_minor,
        requested_date, rate_text, source, publication_date, formula_version
      ) VALUES ('flow-cost', 'UAH', 'UAH', 100, '2099-01-01', '1', 'identity', '2099-01-01', 'official-daily-v1')
    `);

    const flow = await repository.moneyFlow("all", "UAH");
    const chains = await repository.movementChains("all", 120, "UAH");

    expect(flow.transfers).toEqual([
      expect.objectContaining({
        sourceCurrency: "USD",
        sourceAmountMinor: "10000",
        destinationCurrency: "UAH",
        destinationAmountMinor: "400000",
        reportCurrency: "UAH",
        sourceReportAmountMinor: "400000",
        destinationReportAmountMinor: "400000",
      }),
    ]);
    expect(flow.terminalSpending).toEqual([
      expect.objectContaining({ currency: "EUR", amountMinor: "1000", reportCurrency: "UAH", reportAmountMinor: "44000" }),
    ]);
    expect(flow.businessUses).toEqual([
      expect.objectContaining({ currency: "USD", amountMinor: "100", reportCurrency: "UAH", reportAmountMinor: "4000" }),
    ]);
    expect(flow.unlinkedRoutes).toEqual([
      expect.objectContaining({ currency: "EUR", amountMinor: "500", reportCurrency: "UAH", reportAmountMinor: "22000" }),
    ]);
    expect(flow.costs).toEqual([
      expect.objectContaining({ currency: "UAH", amountMinor: "100", reportCurrency: "UAH", reportAmountMinor: "100" }),
    ]);
    expect(flow.missingValuationCount).toBe(0);
    expect(chains).toEqual([
      expect.objectContaining({
        id: "flow-group",
        source: expect.objectContaining({ currency: "USD", amountMinor: "10000", reportCurrency: "UAH", reportAmountMinor: "400000" }),
        destination: expect.objectContaining({ currency: "UAH", amountMinor: "400000", reportCurrency: "UAH", reportAmountMinor: "400000" }),
        costs: [expect.objectContaining({ currency: "UAH", amountMinor: "100", reportCurrency: "UAH", reportAmountMinor: "100" })],
      }),
    ]);
  });

  it("surfaces only safe review summaries plus local candidate detail", async () => {
    await addEntry({ id: "candidate-debit", accountId: "personal-uah", amount: -3_000n, currency: "UAH", kind: "unclassified", description: "SYNTHETIC TRANSFER" });
    await addEntry({ id: "candidate-credit", accountId: "fop-usd", amount: 3_000n, currency: "USD", kind: "unclassified", description: "SYNTHETIC RECEIPT" });
    await database.run("INSERT INTO movement_candidates (id, debit_entry_id, credit_entry_id, match_kind) VALUES ('candidate:test', 'candidate-debit', 'candidate-credit', 'cross_currency')");
    await database.run("INSERT INTO import_artifacts (id, sha256, encrypted_bytes, size_bytes, parser_kind, parser_version) VALUES ('artifact-review', ?, ?, 1, 'privat_personal', 'synthetic@1')", ["f".repeat(64), Buffer.from("S")]);
    await database.run("INSERT INTO import_batches (id, artifact_id, status, row_count, reconciliation_issues_json) VALUES ('batch-review', 'artifact-review', 'committed', 0, '[\"BALANCE_DISCONTINUITY\"]')");

    const review = await repository.review();

    expect(review.candidates).toEqual([expect.objectContaining({ id: "candidate:test", matchKind: "cross_currency", debitAmountMinor: "-3000", creditAmountMinor: "3000" })]);
    expect(review.counts.pendingMovements).toBe(1);
    expect(review.counts.importIssues).toBe(1);
    expect(review.importIssueReasons).toEqual([{ reasonCode: "BALANCE_DISCONTINUITY", count: 1 }]);
    expect(await repository.importBatch("batch-review")).toMatchObject({
      id: "batch-review",
      rowCount: 0,
      postedCount: 0,
      nonPostedCount: 0,
      unresolvedCount: 0,
      rejectedCount: 0,
      issueCodes: ["BALANCE_DISCONTINUITY"],
    });
  });

  it("offers only unlinked statement-fee debits for explicit movement attachment", async () => {
    await addEntry({ id: "fee-open", accountId: "personal-uah", amount: -100n, currency: "UAH", kind: "explicit_fee", description: "SYNTHETIC FEE" });
    await addEntry({ id: "ordinary", accountId: "personal-uah", amount: -200n, currency: "UAH", kind: "terminal_personal_expense", description: "SYNTHETIC PURCHASE" });
    await addEntry({ id: "fee-linked", accountId: "personal-uah", amount: -300n, currency: "UAH", kind: "explicit_fee", description: "SYNTHETIC LINKED FEE" });
    await database.run("UPDATE ledger_entries SET reconciliation_status = 'confirmed' WHERE id = 'fee-linked'");

    expect(await repository.feeAttachmentCandidates()).toEqual([
      expect.objectContaining({ id: "fee-open", accountName: "Personal UAH", amountMinor: "-100", currency: "UAH" }),
    ]);
  });

  it("includes standalone statement fees in the cost-of-money aggregate", async () => {
    await addEntry({ id: "fee-open", accountId: "personal-uah", amount: -175n, currency: "UAH", kind: "explicit_fee", description: "SYNTHETIC FEE" });

    expect((await repository.moneyFlow("all")).costs).toEqual([
      {
        method: "explicit_statement_fee",
        currency: "UAH",
        amountMinor: "175",
        estimated: false,
        componentCount: 1,
      },
    ]);
  });

  it("builds period-aware dashboard, category, and movement aggregates without mixing currencies", async () => {
    await addEntry({ id: "income-old", accountId: "fop-usd", amount: 50_000n, currency: "USD", kind: "business_income", description: "SYNTHETIC OLD", occurredAt: "2098-01-01T10:00:00Z" });
    await addEntry({ id: "groceries-old", accountId: "personal-uah", amount: -5_000n, currency: "UAH", kind: "terminal_personal_expense", description: "SYNTHETIC OLD GROCERIES", occurredAt: "2098-01-02T10:00:00Z" });
    await addEntry({ id: "income", accountId: "fop-usd", amount: 100_000n, currency: "USD", kind: "business_income", description: "SYNTHETIC INCOME", occurredAt: "2099-06-01T10:00:00Z" });
    await addEntry({ id: "draw-out", accountId: "fop-usd", amount: -25_000n, currency: "USD", kind: "fx_sell", description: "SYNTHETIC DRAW", occurredAt: "2099-06-02T10:00:00Z" });
    await addEntry({ id: "draw-in", accountId: "personal-uah", amount: 100_000n, currency: "UAH", kind: "fx_buy", description: "SYNTHETIC DRAW", occurredAt: "2099-06-02T10:01:00Z" });
    await addEntry({ id: "groceries", accountId: "personal-uah", amount: -20_000n, currency: "UAH", kind: "terminal_personal_expense", description: "SYNTHETIC GROCERIES", occurredAt: "2099-06-03T10:00:00Z" });
    await addEntry({ id: "dining", accountId: "personal-uah", amount: -10_000n, currency: "UAH", kind: "terminal_personal_expense", description: "SYNTHETIC DINING", occurredAt: "2099-07-03T10:00:00Z" });
    await addEntry({ id: "tax", accountId: "fop-usd", amount: -5_000n, currency: "USD", kind: "tax", description: "SYNTHETIC TAX", occurredAt: "2099-07-04T10:00:00Z" });
    await database.run("INSERT INTO category_assignments (id, ledger_entry_id, category_id, method, needs_review) VALUES (?, 'groceries-old', 'personal-groceries', 'bank', 0), (?, 'groceries', 'personal-groceries', 'bank', 0), (?, 'dining', 'personal-dining', 'merchant_heuristic', 0)", [randomUUID(), randomUUID(), randomUUID()]);
    await database.run("INSERT INTO movement_groups (id, status, evidence_kind, confirmed_at) VALUES ('movement', 'confirmed', 'automatic_fx', '2099-06-02T10:02:00Z')");
    await database.run("INSERT INTO movement_legs (id, movement_group_id, ledger_entry_id, leg_kind, position) VALUES (?, 'movement', 'draw-out', 'fx_sell', 0), (?, 'movement', 'draw-in', 'fx_buy', 1)", [randomUUID(), randomUUID()]);
    await database.run("INSERT INTO cost_components (id, movement_group_id, method, amount_minor, currency, estimated) VALUES (?, 'movement', 'fx_spread_estimate', 1000, 'UAH', 1)", [randomUUID()]);
    await addEntry({ id: "provider-proceeds", accountId: "fop-uah", amount: 400_000n, currency: "UAH", kind: "fx_buy", description: "SYNTHETIC PROVIDER FX", occurredAt: "2099-06-02T11:00:00Z" });
    await database.run("INSERT INTO movement_groups (id, status, evidence_kind, confirmed_at) VALUES ('provider-fx', 'reconciled', 'provider_fx_description', '2099-06-02T11:01:00Z')");
    await database.run("INSERT INTO movement_legs (id, movement_group_id, ledger_entry_id, leg_kind, position) VALUES (?, 'provider-fx', 'provider-proceeds', 'fx_buy', 0)", [randomUUID()]);
    await database.run("INSERT INTO fx_conversions (id, movement_group_id, sold_amount_minor, sold_currency, received_amount_minor, received_currency, executed_rate_text, benchmark_rate_text, benchmark_source, benchmark_publication_date, formula_version) VALUES (?, 'provider-fx', 10000, 'USD', 400000, 'UAH', '40', '40.5', 'NBU', '2099-06-02', 'fx-cost@1')", [randomUUID()]);
    await addEntry({ id: "unlinked-own", accountId: "fop-uah", amount: -5_000n, currency: "UAH", kind: "unlinked_transfer_out", description: "SYNTHETIC OWN BOUNDARY", occurredAt: "2099-06-03T11:00:00Z" });

    const overview = await repository.overview("12m");
    const categories = await repository.categoryAnalytics("12m");
    const flow = await repository.moneyFlow("12m");
    const chains = await repository.movementChains("12m");

    expect(overview.anchorAt).toBe("2099-07-04T10:00:00Z");
    expect(overview.flows).toEqual([
      { currency: "UAH", grossIncomeMinor: "0", spendingMinor: "30000", internalMovementMinor: "500000" },
      { currency: "USD", grossIncomeMinor: "100000", spendingMinor: "5000", internalMovementMinor: "25000" },
    ]);
    expect(overview.previousFlows).toEqual([
      { currency: "UAH", grossIncomeMinor: "0", spendingMinor: "5000", internalMovementMinor: "0" },
      { currency: "USD", grossIncomeMinor: "50000", spendingMinor: "0", internalMovementMinor: "0" },
    ]);
    expect(overview.timeline).toEqual(expect.arrayContaining([
      { month: "2099-06", currency: "UAH", incomeMinor: "0", spendingMinor: "20000" },
      { month: "2099-07", currency: "UAH", incomeMinor: "0", spendingMinor: "10000" },
      { month: "2099-06", currency: "USD", incomeMinor: "100000", spendingMinor: "0" },
    ]));
    expect(categories.totals).toEqual(expect.arrayContaining([
      expect.objectContaining({ categoryCode: "food", categoryName: "Їжа", currency: "UAH", amountMinor: "30000", transactionCount: 2 }),
    ]));
    expect(categories.previousTotals).toEqual([
      expect.objectContaining({ categoryCode: "food", categoryName: "Їжа", currency: "UAH", amountMinor: "5000", transactionCount: 1 }),
    ]);
    expect(flow.transfers).toEqual(expect.arrayContaining([
      expect.objectContaining({ fromAccountName: "FOP USD", fromOwnerScope: "SOLE_PROPRIETOR", toAccountName: "Personal UAH", toOwnerScope: "PERSONAL", sourceCurrency: "USD", destinationCurrency: "UAH", groupCount: 1 }),
      expect.objectContaining({ fromAccountName: "ФОП USD · валютний пул", fromOwnerScope: "SOLE_PROPRIETOR", toAccountName: "FOP UAH", toOwnerScope: "SOLE_PROPRIETOR", sourceCurrency: "USD", destinationCurrency: "UAH", groupCount: 1 }),
    ]));
    expect(flow.linkedLegs).toBe(3);
    expect(flow.unlinkedRoutes).toEqual([
      expect.objectContaining({ direction: "debit", accountName: "FOP UAH", currency: "UAH", amountMinor: "5000", transactionCount: 1 }),
    ]);
    expect(flow.terminalSpending).toEqual([
      expect.objectContaining({ accountName: "Personal UAH", categoryCode: "food", currency: "UAH", amountMinor: "30000" }),
    ]);
    expect(flow.costs).toEqual([expect.objectContaining({ currency: "UAH", amountMinor: "1000", estimated: true })]);
    expect(chains).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "movement",
        evidenceKind: "automatic_fx",
        source: expect.objectContaining({ accountName: "FOP USD", amountMinor: "25000", currency: "USD" }),
        destination: expect.objectContaining({ accountName: "Personal UAH", amountMinor: "100000", currency: "UAH" }),
        legs: [expect.objectContaining({ entryId: "draw-out" }), expect.objectContaining({ entryId: "draw-in" })],
        costs: [expect.objectContaining({ method: "fx_spread_estimate", amountMinor: "1000", currency: "UAH" })],
      }),
      expect.objectContaining({
        id: "provider-fx",
        source: expect.objectContaining({ accountName: "ФОП USD · валютний пул", amountMinor: "10000", currency: "USD" }),
        destination: expect.objectContaining({ accountName: "FOP UAH", amountMinor: "400000", currency: "UAH" }),
        legs: [expect.objectContaining({ entryId: "provider-proceeds" })],
      }),
    ]));

    await database.run(`
      INSERT INTO fx_conversion_source_valuations (
        fx_conversion_id, source_currency, target_currency, converted_amount_minor,
        requested_date, rate_text, source, publication_date, formula_version
      ) SELECT id, 'USD', 'UAH', 405000, '2099-06-02', '40.5', 'NBU', '2099-06-02', 'official-daily-v1'
        FROM fx_conversions WHERE movement_group_id = 'provider-fx'
    `);
    await database.run(`
      INSERT INTO ledger_entry_valuations (
        ledger_entry_id, source_currency, target_currency, converted_amount_minor,
        requested_date, rate_text, source, publication_date, formula_version
      ) VALUES ('provider-proceeds', 'UAH', 'UAH', 400000, '2099-06-02', '1', 'identity', '2099-06-02', 'official-daily-v1')
    `);
    const convertedFlow = await repository.moneyFlow("12m", "UAH");
    const convertedChains = await repository.movementChains("12m", 120, "UAH");
    expect(convertedFlow.transfers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        fromAccountName: "ФОП USD · валютний пул",
        sourceReportAmountMinor: "405000",
        destinationReportAmountMinor: "400000",
        sourceValuationMissingCount: 0,
      }),
    ]));
    expect(convertedChains).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "provider-fx",
        source: expect.objectContaining({ reportAmountMinor: "405000", reportCurrency: "UAH" }),
      }),
    ]));

    const movementTransaction = (await repository.transactions({ query: "synthetic draw" })).find(({ id }) => id === "draw-out");
    expect(movementTransaction).toMatchObject({
      movementGroupId: "movement",
      movementStatus: "confirmed",
      movementEvidenceKind: "automatic_fx",
      movementCostCount: 1,
    });

    const currentPage = await repository.transactionPage({ period: "12m", pageSize: 50 });
    expect(currentPage.items.map(({ id }) => id)).not.toContain("income-old");
    expect(currentPage.items.map(({ id }) => id)).not.toContain("groceries-old");
  });

  it("returns server-paginated transaction results and compact data health", async () => {
    for (let index = 1; index <= 5; index += 1) {
      await addEntry({
        id: `page-${index}`,
        accountId: "personal-uah",
        amount: BigInt(-index * 100),
        currency: "UAH",
        kind: "terminal_personal_expense",
        description: `SYNTHETIC PAGE ${index}`,
        occurredAt: `2099-01-0${index}T10:00:00Z`,
      });
    }
    await database.run("INSERT INTO movement_candidates (id, debit_entry_id, credit_entry_id, match_kind, status, reviewed_at) VALUES ('candidate-rejected', 'page-1', 'page-2', 'exact', 'rejected', '2099-01-06T00:00:00Z')");

    const page = await repository.transactionPage({ page: 2, pageSize: 2, query: "synthetic page" });
    const health = await repository.dataHealth();

    expect(page).toMatchObject({ total: 5, page: 2, pageSize: 2, pageCount: 3 });
    expect(page.items.map(({ id }) => id)).toEqual(["page-3", "page-2"]);
    expect(health).toMatchObject({ rejectedCandidates: 1, pendingCandidates: 0, personalEntries: 5, categorizedPersonalEntries: 0 });
  });

  it("applies an exclusive upper bound to calendar-month transaction pages", async () => {
    await addEntry({
      id: "january-last",
      accountId: "personal-uah",
      amount: -100n,
      currency: "UAH",
      kind: "terminal_personal_expense",
      description: "SYNTHETIC JANUARY",
      occurredAt: "2099-01-31T23:59:59Z",
    });
    await addEntry({
      id: "february-first",
      accountId: "personal-uah",
      amount: -200n,
      currency: "UAH",
      kind: "terminal_personal_expense",
      description: "SYNTHETIC FEBRUARY",
      occurredAt: "2099-02-01T00:00:00",
    });

    const page = await repository.transactionPage({
      from: "2099-01-01T00:00:00.000Z",
      to: "2099-02-01T00:00:00.000Z",
      pageSize: 50,
    });

    expect(page.items.map(({ id }) => id)).toEqual(["january-last"]);
    expect(page.total).toBe(1);
  });
});

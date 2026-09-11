import { describe, expect, it } from "vitest";

import { hmacIdentifier } from "@/domain/privacy";
import { PrivatPersonalStatementAdapter } from "@/server/import/privat-personal";
import { workbookFromRows, workbookWithFormula } from "../helpers/workbook";

const HEADERS = [
  "Дата",
  "Категорія",
  "Картка",
  "Опис операції",
  "Сума в валюті картки",
  "Валюта картки",
  "Сума в валюті транзакції",
  "Валюта транзакції",
  "Залишок на кінець періоду",
  "Валюта залишку",
];
const KEY = Buffer.alloc(32, 3);

function statement(rows: unknown[][]): Buffer {
  return workbookFromRows([["SYNTHETIC PRIVAT EXPORT"], HEADERS, ...rows]);
}

describe("Privat personal statement adapter", () => {
  it("probes the format and discovers instruments without exposing identifiers", () => {
    const adapter = new PrivatPersonalStatementAdapter({ identifierKey: KEY });
    const input = statement([
      ["01.01.2099 10:00:00", "Synthetic", "SYNTH-CARD-0001", "SYNTHETIC CREDIT", "100.00", "UAH", "100.00", "UAH", "100.00", "UAH"],
      ["02.01.2099 10:00:00", "Synthetic", "SYNTH-CARD-0002", "SYNTHETIC DEBIT", "-20.00", "UAH", "-20.00", "UAH", "80.00", "UAH"],
    ]);

    expect(adapter.probe(input)).toMatchObject({ matched: true, kind: "privat_personal" });
    const parsed = adapter.parse(input);
    const instruments = adapter.discoverInstruments(parsed);
    expect(instruments).toHaveLength(2);
    expect(instruments[0]?.display).toBe("•••• 0001");
    expect(instruments[0]?.currencies).toEqual(["UAH"]);
    expect(JSON.stringify(instruments)).not.toContain("SYNTH-CARD");
  });

  it("normalizes per-row instruments, settlement/source amounts, and exact balances", () => {
    const adapter = new PrivatPersonalStatementAdapter({ identifierKey: KEY });
    const input = statement([
      ["01.01.2099 10:00:00", "Synthetic", "SYNTH-CARD-0001", "SYNTHETIC CREDIT", "100.00", "UAH", "2.50", "USD", "100.00", "UAH"],
      ["02.01.2099 10:00:00", "Synthetic", "SYNTH-CARD-0001", "SYNTHETIC DEBIT", "-20.00", "UAH", "-0.50", "USD", "80.00", "UAH"],
    ]);
    const instrumentHash = hmacIdentifier("SYNTH-CARD-0001", KEY);
    const normalized = adapter.normalize(adapter.parse(input), {
      ownership: new Map([[instrumentHash, { accountId: "personal-uah", instrumentId: "card-one" }]]),
      mappingComplete: true,
    });

    expect(normalized.rows.map((row) => row.state)).toEqual(["posted", "posted"]);
    expect(normalized.rows[0]?.observations[0]).toMatchObject({
      accountId: "personal-uah",
      amountMinor: 10_000n,
      currency: "UAH",
      sourceAmountMinor: 250n,
      sourceCurrency: "USD",
      resultingBalanceMinor: 10_000n,
    });
    expect(normalized.rows[1]?.observations[0]?.amountMinor).toBe(-2_000n);
    expect(adapter.reconcile(normalized)).toMatchObject({
      rowCount: 2,
      coveredRowCount: 2,
      balanceChecks: { checked: 1, failed: 0 },
    });
  });

  it("marks unmapped instruments and balance gaps unresolved without dropping rows", () => {
    const adapter = new PrivatPersonalStatementAdapter({ identifierKey: KEY });
    const parsed = adapter.parse(
      statement([
        ["01.01.2099 10:00:00", "Synthetic", "SYNTH-CARD-0001", "SYNTHETIC CREDIT", "100.00", "UAH", "100.00", "UAH", "100.00", "UAH"],
        ["02.01.2099 10:00:00", "Synthetic", "SYNTH-CARD-0001", "SYNTHETIC DEBIT", "-20.00", "UAH", "-20.00", "UAH", "70.00", "UAH"],
        ["03.01.2099 10:00:00", "Synthetic", "SYNTH-CARD-0002", "SYNTHETIC UNKNOWN", "-1.00", "UAH", "-1.00", "UAH", "0.00", "UAH"],
      ]),
    );
    const firstHash = hmacIdentifier("SYNTH-CARD-0001", KEY);
    const normalized = adapter.normalize(parsed, {
      ownership: new Map([[firstHash, { accountId: "personal-uah", instrumentId: "card-one" }]]),
      mappingComplete: false,
    });
    const summary = adapter.reconcile(normalized);

    expect(normalized.rows).toHaveLength(3);
    expect(normalized.rows[2]).toMatchObject({ state: "unresolved", reasonCode: "OWNERSHIP_MAPPING_REQUIRED" });
    expect(summary.balanceChecks).toEqual({ checked: 1, failed: 1 });
    expect(summary.issues).toContain("BALANCE_DISCONTINUITY");
  });

  it("does not treat a repeated period-end balance as a per-row running balance", () => {
    const adapter = new PrivatPersonalStatementAdapter({ identifierKey: KEY });
    const parsed = adapter.parse(statement([
      ["01.01.2099 10:00:00", "Synthetic", "SYNTH-CARD-0001", "SYNTHETIC CREDIT", "100.00", "UAH", "100.00", "UAH", "80.00", "UAH"],
      ["02.01.2099 10:00:00", "Synthetic", "SYNTH-CARD-0001", "SYNTHETIC DEBIT", "-20.00", "UAH", "-20.00", "UAH", "80.00", "UAH"],
    ]));
    const instrumentHash = hmacIdentifier("SYNTH-CARD-0001", KEY);
    const normalized = adapter.normalize(parsed, {
      ownership: new Map([[instrumentHash, { accountId: "personal-uah", instrumentId: "card-one" }]]),
      mappingComplete: true,
    });

    expect(adapter.reconcile(normalized)).toMatchObject({
      balanceChecks: { checked: 0, failed: 0 },
      issues: [],
    });
  });

  it("rejects formula-bearing rows rather than evaluating them", () => {
    const rows = [
      ["SYNTHETIC PRIVAT EXPORT"],
      HEADERS,
      ["01.01.2099 10:00:00", "Synthetic", "SYNTH-CARD-0001", "SYNTHETIC FORMULA", "10.00", "UAH", "10.00", "UAH", "10.00", "UAH"],
    ];
    const adapter = new PrivatPersonalStatementAdapter({ identifierKey: KEY });
    const parsed = adapter.parse(workbookWithFormula(rows, "E3", "1+1"));
    const normalized = adapter.normalize(parsed, { ownership: new Map(), mappingComplete: true });
    expect(normalized.rows[0]).toMatchObject({ state: "rejected", reasonCode: "FORMULA_NOT_ALLOWED" });
  });
});

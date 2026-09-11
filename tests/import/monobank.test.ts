import { describe, expect, it } from "vitest";

import { hmacIdentifier } from "@/domain/privacy";
import { MonobankStatementAdapter } from "@/server/import/monobank";
import { legacyWorkbookFromRows, workbookWithFormula } from "../helpers/workbook";

const KEY = Buffer.alloc(32, 47);
const ACCOUNT = "SYNTHETIC-IBAN-0001";
const CARD = "SYNTHETIC-CARD-0002";
const HEADERS = [
  "Дата і час операції",
  "Деталі операції",
  "MCC",
  "Сума в валюті картки (UAH)",
  "Сума в валюті операції",
  "Валюта",
  "Курс",
  "Сума комісій (UAH)",
  "Сума кешбеку (UAH)",
  "Залишок після операції",
];

function rows(): unknown[][] {
  return [
    ["Клієнт: SYNTHETIC PERSON"],
    ["ІПН: SYNTHETIC-TAX-ID"],
    [`Інформація по картці: ${CARD}`],
    [`Рахунок: ${ACCOUNT}`],
    ["Період: SYNTHETIC PERIOD"],
    HEADERS,
    ["02.09.2099 12:00:00", "SYNTHETIC CREDIT", 4829, 20, 20, "UAH", 1, 0, 0, 109.5],
    ["01.09.2099 12:00:00", "SYNTHETIC MARKET", 5411, -10.5, -0.25, "USD", 42, 0.5, 0.1, 89.5],
  ];
}

function statement(): Buffer {
  return legacyWorkbookFromRows(rows());
}

describe("Monobank personal statement adapter", () => {
  it("probes the legacy XLS format and discovers one account with its card instrument", () => {
    const adapter = new MonobankStatementAdapter({ identifierKey: KEY });
    expect(adapter.probe(statement())).toEqual({ matched: true, kind: "monobank_personal" });

    const parsed = adapter.parse(statement());
    expect(parsed.rows).toHaveLength(2);
    expect(parsed).not.toHaveProperty("taxId");
    expect(JSON.stringify(parsed)).not.toContain("SYNTHETIC-TAX-ID");
    expect(adapter.discoverAccounts(parsed)).toEqual([{
      identifierHash: hmacIdentifier(ACCOUNT, KEY),
      display: "•••• 0001",
      currencies: ["UAH"],
      instrumentIdentifierHash: hmacIdentifier(`${ACCOUNT}:${CARD}`, KEY),
      instrumentDisplay: "•••• 0002",
    }]);
  });

  it("normalizes settlement, source, rate, fee, cashback, MCC, and balance evidence", () => {
    const adapter = new MonobankStatementAdapter({ identifierKey: KEY });
    const parsed = adapter.parse(statement());
    const accountHash = hmacIdentifier(ACCOUNT, KEY);
    const instrumentHash = hmacIdentifier(`${ACCOUNT}:${CARD}`, KEY);
    const normalized = adapter.normalize(parsed, {
      mappingComplete: true,
      ownership: new Map([[accountHash, {
        accountId: "mono-uah",
        instrumentId: "mono-card",
        instrumentIdentifierHash: instrumentHash,
        ownerScope: "PERSONAL",
      }]]),
    });

    expect(normalized.kind).toBe("monobank_personal");
    const purchase = normalized.rows.find(({ sourceMetadata }) => sourceMetadata.mcc === "5411");
    expect(purchase).toMatchObject({
      state: "posted",
      direction: "debit",
      sourceMetadata: {
        mcc: "5411",
        providerRate: "42",
        explicitFeeMinor: "50",
        explicitFeeCurrency: "UAH",
        cashbackMinor: "10",
        cashbackCurrency: "UAH",
      },
    });
    expect(purchase?.observations[0]).toMatchObject({
      provider: "monobank",
      accountId: "mono-uah",
      instrumentId: "mono-card",
      instrumentIdentifierHash: instrumentHash,
      amountMinor: -1_050n,
      currency: "UAH",
      sourceAmountMinor: -25n,
      sourceCurrency: "USD",
      resultingBalanceMinor: 8_950n,
      resultingBalanceCurrency: "UAH",
      occurredAt: "2099-09-01T12:00:00",
      ownIdentifierHash: accountHash,
      description: "SYNTHETIC MARKET",
    });
  });

  it("treats Monobank dash placeholders as absent optional fee and cashback amounts", () => {
    const sourceRows = rows();
    for (const row of sourceRows.slice(-2)) {
      row[7] = "-";
      row[8] = "—";
    }
    const adapter = new MonobankStatementAdapter({ identifierKey: KEY });
    const parsed = adapter.parse(legacyWorkbookFromRows(sourceRows));
    const accountHash = hmacIdentifier(ACCOUNT, KEY);
    const normalized = adapter.normalize(parsed, {
      mappingComplete: true,
      ownership: new Map([[accountHash, {
        accountId: "mono-uah",
        instrumentId: "mono-card",
        instrumentIdentifierHash: hmacIdentifier(`${ACCOUNT}:${CARD}`, KEY),
        ownerScope: "PERSONAL",
      }]]),
    });

    expect(normalized.rows).toHaveLength(2);
    expect(normalized.rows.every(({ state }) => state === "posted")).toBe(true);
    expect(normalized.rows.every(({ sourceMetadata }) => (
      sourceMetadata.explicitFeeMinor === "0" && sourceMetadata.cashbackMinor === "0"
    ))).toBe(true);
  });

  it("partitions every row and reports exact running-balance continuity", () => {
    const adapter = new MonobankStatementAdapter({ identifierKey: KEY });
    const parsed = adapter.parse(statement());
    const accountHash = hmacIdentifier(ACCOUNT, KEY);
    const normalized = adapter.normalize(parsed, {
      mappingComplete: true,
      ownership: new Map([[accountHash, {
        accountId: "mono-uah",
        instrumentId: "mono-card",
        instrumentIdentifierHash: hmacIdentifier(`${ACCOUNT}:${CARD}`, KEY),
        ownerScope: "PERSONAL",
      }]]),
    });

    expect(adapter.reconcile(normalized)).toMatchObject({
      rowCount: 2,
      coveredRowCount: 2,
      silentlySkippedRowCount: 0,
      stateCounts: { posted: 2, non_posted: 0, unresolved: 0, rejected: 0 },
      issues: [],
      balanceChecks: { checked: 1, failed: 0 },
    });
  });

  it("rejects a formula-bearing source row without silently skipping it", () => {
    const adapter = new MonobankStatementAdapter({ identifierKey: KEY });
    const formula = workbookWithFormula(rows(), "D7", "1+1");
    const parsed = adapter.parse(formula);
    const normalized = adapter.normalize(parsed, { ownership: new Map(), mappingComplete: true });

    expect(normalized.rows[0]).toMatchObject({ state: "rejected", reasonCode: "FORMULA_NOT_ALLOWED" });
    expect(adapter.reconcile(normalized)).toMatchObject({ rowCount: 2, coveredRowCount: 2, silentlySkippedRowCount: 0 });
  });
});

import { describe, expect, it } from "vitest";

import { hmacIdentifier } from "@/domain/privacy";
import { PrivatFopJournalAdapter } from "@/server/import/privat-fop";
import { workbookFromRows } from "../helpers/workbook";

const HEADERS = [
  "№", "Дата проведення", "Сума", "Валюта", "Рахунок відправника", "ЄДРПОУ відправника",
  "Найменування відправника", "Рахунок отримувача", "ЄДРПОУ отримувача", "Назва банку отримувача",
  "Код банку отримувача", "Найменування отримувача", "Призначення платежу", "Стан платежу",
  "Дата валютування", "Дата створення", "Код країни резидентства отримувача", "Найменування кінцевого платника",
  "Код ЄДРПОУ / ІПН кінцевого платника", "Серія паспорту кінцевого платника", "Номер паспорту кінцевого платника",
  "ID паспорту кінцевого платника", "Найменування кінцевого отримувача", "Код ЄДРПОУ / ІПН кінцевого отримувача",
  "Серія паспорту кінцевого отримувача", "Номер паспорту кінцевого отримувача", "ID паспорту кінцевого отримувача",
];
const KEY = Buffer.alloc(32, 4);

function row({
  number,
  conducted = "01.01.2099 10:00:00",
  amount = "100.00",
  currency = "USD",
  sender = "SYNTH-EXTERNAL-0001",
  recipient = "SYNTH-FOP-USD-0001",
  status = "Отримано",
  purpose = "SYNTHETIC PURPOSE",
}: {
  number: string;
  conducted?: string;
  amount?: string;
  currency?: string;
  sender?: string;
  recipient?: string;
  status?: string;
  purpose?: string;
}): unknown[] {
  const values = new Array(27).fill("");
  values[0] = number;
  values[1] = conducted;
  values[2] = amount;
  values[3] = currency;
  values[4] = sender;
  values[6] = "SYNTHETIC SENDER";
  values[7] = recipient;
  values[11] = "SYNTHETIC RECIPIENT";
  values[12] = purpose;
  values[13] = status;
  values[15] = "01.01.2099 09:00:00";
  values[18] = "SYNTHETIC-TAX-ID";
  values[20] = "SYNTHETIC-PASSPORT";
  return values;
}

function journal(rows: unknown[][]): Buffer {
  return workbookFromRows([HEADERS, ...rows]);
}

describe("Privat FOP journal adapter", () => {
  it("discovers only masked account candidates for explicit ownership review", () => {
    const adapter = new PrivatFopJournalAdapter({ identifierKey: KEY });
    const parsed = adapter.parse(journal([row({ number: "SYNTH-DISCOVERY" })]));
    const accounts = adapter.discoverAccounts(parsed);
    expect(accounts).toHaveLength(2);
    expect(accounts.every(({ display }) => display.startsWith("•••• "))).toBe(true);
    expect(accounts.every(({ currencies }) => currencies.includes("USD"))).toBe(true);
    expect(JSON.stringify(accounts)).not.toContain("SYNTH-");
  });

  it("classifies every status and never treats the source number as a unique transaction ID", () => {
    const adapter = new PrivatFopJournalAdapter({ identifierKey: KEY });
    const parsed = adapter.parse(journal([
      row({ number: "SYNTH-DUPLICATE" }),
      row({ number: "SYNTH-DUPLICATE", status: "Сплачено", sender: "SYNTH-FOP-USD-0001", recipient: "SYNTH-EXTERNAL-0002" }),
      row({ number: "SYNTH-SAVED", status: "Збережено", conducted: "" }),
      row({ number: "SYNTH-MISSING-DATE", status: "Сплачено", conducted: "", sender: "SYNTH-FOP-USD-0001", recipient: "SYNTH-EXTERNAL-0003" }),
      row({ number: "SYNTH-UNKNOWN", status: "SYNTHETIC UNKNOWN STATUS" }),
    ]));
    const own = hmacIdentifier("SYNTH-FOP-USD-0001", KEY);
    const normalized = adapter.normalize(parsed, {
      ownership: new Map([[own, { accountId: "fop-usd", ownerScope: "SOLE_PROPRIETOR" }]]),
      mappingComplete: true,
    });

    expect(normalized.rows.map(({ state, reasonCode }) => [state, reasonCode])).toEqual([
      ["posted", undefined],
      ["posted", undefined],
      ["non_posted", "PAYMENT_SAVED"],
      ["unresolved", "CONDUCTED_DATE_MISSING"],
      ["rejected", "STATUS_UNSUPPORTED"],
    ]);
    expect(normalized.rows).toHaveLength(5);
    expect(normalized.rows[3]?.undatedObservations).toEqual([
      expect.objectContaining({ accountId: "fop-usd", direction: "debit", amountMinor: -10_000n, currency: "USD" }),
    ]);
    expect(normalized.rows[0]?.sourceMetadata.sourceNumber).toBe("SYNTH-DUPLICATE");
    expect(normalized.rows[0]?.sourceRecordId).not.toBe(normalized.rows[1]?.sourceRecordId);
  });

  it("derives credit, debit, internal, and evidence-only roles strictly from ownership", () => {
    const adapter = new PrivatFopJournalAdapter({ identifierKey: KEY });
    const parsed = adapter.parse(journal([
      row({ number: "SYNTH-CREDIT", sender: "SYNTH-EXTERNAL-0001", recipient: "SYNTH-FOP-USD-0001" }),
      row({ number: "SYNTH-DEBIT", status: "Сплачено", sender: "SYNTH-FOP-USD-0001", recipient: "SYNTH-EXTERNAL-0002" }),
      row({ number: "SYNTH-INTERNAL", status: "Сплачено", sender: "SYNTH-FOP-USD-0001", recipient: "SYNTH-FOP-UAH-0001", amount: "250.00", currency: "UAH" }),
      row({ number: "SYNTH-NEITHER", sender: "SYNTH-EXTERNAL-0003", recipient: "SYNTH-EXTERNAL-0004" }),
    ]));
    const ownership = new Map([
      [hmacIdentifier("SYNTH-FOP-USD-0001", KEY), { accountId: "fop-usd", ownerScope: "SOLE_PROPRIETOR" as const }],
      [hmacIdentifier("SYNTH-FOP-UAH-0001", KEY), { accountId: "fop-uah", ownerScope: "SOLE_PROPRIETOR" as const }],
    ]);
    const normalized = adapter.normalize(parsed, { ownership, mappingComplete: true });

    expect(normalized.rows[0]?.observations).toHaveLength(1);
    expect(normalized.rows[0]?.observations[0]).toMatchObject({ direction: "credit", accountId: "fop-usd", amountMinor: 10_000n });
    expect(normalized.rows[1]?.observations[0]).toMatchObject({ direction: "debit", accountId: "fop-usd", amountMinor: -10_000n });
    expect(normalized.rows[2]?.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ direction: "debit", accountId: "fop-usd", amountMinor: -25_000n }),
      expect.objectContaining({ direction: "credit", accountId: "fop-uah", amountMinor: 25_000n }),
    ]));
    expect(normalized.rows[3]).toMatchObject({ state: "posted", direction: "evidence_only", observations: [] });
  });

  it("keeps regulated identity columns out of normalized records and reconciles row coverage/totals", () => {
    const adapter = new PrivatFopJournalAdapter({ identifierKey: KEY });
    const own = hmacIdentifier("SYNTH-FOP-USD-0001", KEY);
    const normalized = adapter.normalize(adapter.parse(journal([row({ number: "SYNTH-ONE" })])), {
      ownership: new Map([[own, { accountId: "fop-usd", ownerScope: "SOLE_PROPRIETOR" }]]),
      mappingComplete: true,
    });
    const serialized = JSON.stringify(normalized, (_key, value) => (typeof value === "bigint" ? value.toString() : value));
    const summary = adapter.reconcile(normalized);

    expect(serialized).not.toContain("SYNTHETIC-TAX-ID");
    expect(serialized).not.toContain("SYNTHETIC-PASSPORT");
    expect(summary).toMatchObject({ rowCount: 1, coveredRowCount: 1, silentlySkippedRowCount: 0 });
    expect(summary.totals).toEqual([{ currency: "USD", creditMinor: 10_000n, debitMinor: 0n }]);
    expect(summary.balanceEvidence).toBe("unavailable");
  });

  it("keeps explicit FX source amount evidence from a proceeds row", () => {
    const adapter = new PrivatFopJournalAdapter({ identifierKey: KEY });
    const own = hmacIdentifier("SYNTH-FOP-UAH-0001", KEY);
    const normalized = adapter.normalize(adapter.parse(journal([row({
      number: "SYNTH-FX",
      amount: "40000.00",
      currency: "UAH",
      recipient: "SYNTH-FOP-UAH-0001",
      purpose: "Гривні від продажу 1 000.00 USD по курсу 40.00",
    })])), {
      ownership: new Map([[own, { accountId: "fop-uah", ownerScope: "SOLE_PROPRIETOR" }]]),
      mappingComplete: true,
    });

    expect(normalized.rows[0]?.observations[0]).toMatchObject({
      sourceAmountMinor: 100_000n,
      sourceCurrency: "USD",
    });
  });
});

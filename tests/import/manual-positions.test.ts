import { describe, expect, it } from "vitest";
import { syntheticManualWorkbook } from "../helpers/manual-workbook";
import { parsePositionWorkbook } from "@/server/manual/position-workbook";

describe("manual position workbook (synthetic only)", () => {
  it("keeps direct inputs with month precision, zero, and cell provenance", () => {
    const result = parsePositionWorkbook(syntheticManualWorkbook());
    expect(result.positions).toHaveLength(9);
    expect(result.positions[0]).toMatchObject({ period: "2099-01", amountMinor: "10125", currency: "EUR", address: "C2", provider: "erste" });
    expect(result.positions.find((p) => p.address === "E2")?.amountMinor).toBe("0");
    expect(result.positions.find((p) => p.address === "F2")).toBeUndefined();
    expect(result.cells.find((c) => c.address === "H2" && c.sheet === "Savings")?.disposition).toBe("formula_only");
    expect(result.cells.filter((c) => c.sheet === "Budget").every((c) => c.reason === "DOMAIN_DEFERRED")).toBe(true);
    expect(result.cells.filter((c) => c.disposition === "manual_fact")).toHaveLength(9);
  });
  it("never accepts formula caches even inside the position matrix", () => {
    const result = parsePositionWorkbook(syntheticManualWorkbook({ cells: { C2: { t: "n", v: 500, f: "99+401", z: '[$€]0.00' } } }));
    expect(result.positions.some((p) => p.address === "C2")).toBe(false);
    expect(result.cells.find((c) => c.address === "C2")?.disposition).toBe("formula_only");
  });
  it("quarantines both duplicate periods and unsupported period labels", () => {
    const result = parsePositionWorkbook(syntheticManualWorkbook({ rows: [[1, "January 2099", 10], [2, "January 2099", 10], [3, "Unknown period", 10]] }));
    expect(result.positions).toHaveLength(0);
    expect(result.cells.filter((c) => c.address.startsWith("C") && c.address !== "C1").map((c) => c.reason)).toEqual(["PERIOD_DUPLICATE", "PERIOD_DUPLICATE", "PERIOD_INVALID"]);
  });
  it("does not guess a native currency or round excess precision", () => {
    const result = parsePositionWorkbook(syntheticManualWorkbook({ cells: { C2: { t: "n", v: 10, z: "General" }, D2: { t: "n", v: 10.123, z: '[$€]0.00' } } }));
    expect(result.cells.find((c) => c.address === "C2")?.reason).toBe("CURRENCY_UNPROVEN");
    expect(result.cells.find((c) => c.address === "D2")?.reason).toBe("MONEY_PRECISION");
  });
  it("ignores formatted empty space but accounts for every populated cell", () => {
    const result = parsePositionWorkbook(syntheticManualWorkbook({ inflatedRange: true }));
    expect(result.positions).toHaveLength(9);
    expect(new Set(result.cells.map((c) => `${c.sheet}:${c.address}`)).size).toBe(result.cells.length);
  });
  it("rejects an unrecognized header contract and empty input with safe codes", () => {
    expect(() => parsePositionWorkbook(syntheticManualWorkbook({ cells: { C1: { t: "s", v: "Unknown asset" } } }))).toThrow("MANUAL_HEADERS_UNSUPPORTED");
    expect(() => parsePositionWorkbook(Buffer.alloc(0))).toThrow("MANUAL_ARTIFACT_SIZE");
  });
  it("rejects excessive declared expansion before parsing an XLSX archive", () => {
    const bytes = syntheticManualWorkbook();
    const directory = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bytes.writeUInt32LE(200 * 1024 * 1024, directory + 24);
    expect(() => parsePositionWorkbook(bytes)).toThrow("MANUAL_ARCHIVE_LIMIT");
  });
});

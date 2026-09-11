import { describe, expect, it } from "vitest";

import {
  addMoney,
  formatMinorUnits,
  parseMinorUnits,
  requireInt64,
} from "@/domain/money";

describe("minor-unit money", () => {
  it("parses decimal text exactly without binary floating point", () => {
    expect(parseMinorUnits("123.45", "UAH")).toBe(12_345n);
    expect(parseMinorUnits("-0,01", "EUR")).toBe(-1n);
    expect(parseMinorUnits("0.00000001", "BTC")).toBe(1n);
    expect(formatMinorUnits(-1n, "USD")).toBe("-0.01");
  });

  it("supports the ISO currencies present in Privat merchant amounts", () => {
    expect(parseMinorUnits("1.23", "MDL")).toBe(123n);
    expect(parseMinorUnits("4.56", "RON")).toBe(456n);
  });

  it("rejects fractional precision, unknown currencies, and int64 overflow", () => {
    expect(() => parseMinorUnits("1.001", "USD")).toThrow("MONEY_PRECISION");
    expect(() => parseMinorUnits("1", "SYNTH")).toThrow("CURRENCY_UNSUPPORTED");
    expect(() => requireInt64(9_223_372_036_854_775_808n)).toThrow("MONEY_INT64_RANGE");
  });

  it("will not add different currencies", () => {
    expect(addMoney({ amountMinor: 100n, currency: "UAH" }, { amountMinor: 50n, currency: "UAH" })).toEqual({
      amountMinor: 150n,
      currency: "UAH",
    });
    expect(() => addMoney({ amountMinor: 1n, currency: "UAH" }, { amountMinor: 1n, currency: "USD" })).toThrow(
      "MONEY_CURRENCY_MISMATCH",
    );
  });
});

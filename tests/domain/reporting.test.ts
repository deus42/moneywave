import { describe, expect, it } from "vitest";

import {
  buildMonthRange,
  parseReportCurrency,
  parseReportMonth,
  parseReportPeriod,
  previousReportPeriodRange,
  reportMonthRange,
  reportPeriodStart,
  selectedReportMonth,
  reportMonthAsOf,
  adjacentReportMonth,
} from "@/domain/reporting";

describe("reporting periods", () => {
  it("accepts calendar months and compares whole adjacent months", () => {
    expect(parseReportPeriod("2024-02")).toBe("2024-02");
    expect(parseReportPeriod("2024-13")).toBe("24m");
    expect(reportPeriodStart("2026-09-09", "2024-02")).toBe("2024-02-01T00:00:00.000Z");
    expect(reportMonthRange("2024-02")).toEqual({ startAt: "2024-02-01T00:00:00.000Z", endAt: "2024-03-01T00:00:00.000Z" });
    expect(previousReportPeriodRange("2026-09-09", "2024-01")).toEqual({ startAt: "2023-12-01T00:00:00.000Z", endAt: "2024-01-01T00:00:00.000Z" });
  });

  it("shares a bounded month selection and month-end balance date", () => {
    const now = new Date("2026-09-09T12:00:00Z");
    expect(selectedReportMonth(undefined, now)).toBe("2026-09");
    expect(selectedReportMonth("2026-10", now)).toBe("2026-09");
    expect(selectedReportMonth("2024-02", now)).toBe("2024-02");
    expect(adjacentReportMonth("2025-01", -1)).toBe("2024-12");
    expect(adjacentReportMonth("2024-12", 1)).toBe("2025-01");
    expect(reportMonthAsOf("2024-02", now)).toBe("2024-02-29");
    expect(reportMonthAsOf("2026-09", now)).toBe("2026-09-09");
  });
  it("accepts only supported report periods", () => {
    expect(parseReportPeriod("30d")).toBe("30d");
    expect(parseReportPeriod("90d")).toBe("90d");
    expect(parseReportPeriod("12m")).toBe("12m");
    expect(parseReportPeriod("24m")).toBe("24m");
    expect(parseReportPeriod("all")).toBe("all");
    expect(parseReportPeriod("arbitrary")).toBe("24m");
    expect(parseReportPeriod(undefined)).toBe("24m");
  });

  it("derives UTC boundaries from the latest ledger evidence", () => {
    expect(reportPeriodStart("2099-09-20T12:00:00.000Z", "30d")).toBe("2099-08-21T00:00:00.000Z");
    expect(reportPeriodStart("2099-09-20T12:00:00.000Z", "90d")).toBe("2099-06-22T00:00:00.000Z");
    expect(reportPeriodStart("2099-09-20T12:00:00.000Z", "12m")).toBe("2098-10-01T00:00:00.000Z");
    expect(reportPeriodStart("2099-09-20T12:00:00.000Z", "24m")).toBe("2097-09-20T00:00:00.000Z");
    expect(reportPeriodStart("2099-09-20T12:00:00.000Z", "all")).toBeNull();
  });

  it("fills a deterministic inclusive month range", () => {
    expect(buildMonthRange("2099-06-01T00:00:00.000Z", "2099-09-20T12:00:00.000Z")).toEqual([
      "2099-06",
      "2099-07",
      "2099-08",
      "2099-09",
    ]);
  });

  it("accepts only canonical report months", () => {
    expect(parseReportMonth("2099-01")).toBe("2099-01");
    expect(parseReportMonth(["2099-12"])).toBe("2099-12");
    expect(parseReportMonth("2099-1")).toBeNull();
    expect(parseReportMonth("2099-13")).toBeNull();
    expect(parseReportMonth("2099-01-extra")).toBeNull();
    expect(parseReportMonth(undefined)).toBeNull();
  });

  it("derives an exact UTC month window", () => {
    expect(reportMonthRange("2099-12")).toEqual({
      startAt: "2099-12-01T00:00:00.000Z",
      endAt: "2100-01-01T00:00:00.000Z",
    });
  });

  it("accepts only the three canonical report currencies independently of native accounts", () => {
    expect(parseReportCurrency("usd", ["UAH", "USD", "EUR"])).toBe("USD");
    expect(parseReportCurrency(["EUR"], ["UAH", "USD", "EUR"])).toBe("EUR");
    expect(parseReportCurrency("GBP", ["USD", "UAH"])).toBe("UAH");
    expect(parseReportCurrency(undefined, ["EUR", "USD"])).toBe("UAH");
    expect(parseReportCurrency("UAH", [])).toBe("UAH");
  });

  it("derives the immediately preceding comparison window", () => {
    expect(previousReportPeriodRange("2099-09-20T12:00:00.000Z", "30d")).toEqual({
      startAt: "2099-07-22T00:00:00.000Z",
      endAt: "2099-08-21T00:00:00.000Z",
    });
    expect(previousReportPeriodRange("2099-09-20T12:00:00.000Z", "90d")).toEqual({
      startAt: "2099-03-24T00:00:00.000Z",
      endAt: "2099-06-22T00:00:00.000Z",
    });
    expect(previousReportPeriodRange("2099-09-20T12:00:00.000Z", "12m")).toEqual({
      startAt: "2097-10-01T00:00:00.000Z",
      endAt: "2098-10-01T00:00:00.000Z",
    });
    expect(previousReportPeriodRange("2099-09-20T12:00:00.000Z", "24m")).toEqual({
      startAt: "2095-09-20T00:00:00.000Z",
      endAt: "2097-09-20T00:00:00.000Z",
    });
    expect(previousReportPeriodRange("2099-09-20T12:00:00.000Z", "all")).toBeNull();
  });
});

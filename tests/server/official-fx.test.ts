import { describe, expect, it, vi } from "vitest";

import {
  EcbHistoricalRateLoader,
  EcbRateProvider,
  NbuHistoricalRateLoader,
  NbuRateProvider,
} from "@/server/fx/official-providers";
import { HistoricalRateBook } from "@/server/fx/historical-rates";

describe("official FX providers", () => {
  it("selects the latest ECB publication on or before the requested date and derives a cross-rate", async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const currency = new URL(url).pathname.includes("USD") ? "USD" : "UAH";
      const csv = currency === "USD"
        ? "TIME_PERIOD,OBS_VALUE\n2099-01-01,1.20\n2099-01-02,1.25\n"
        : "TIME_PERIOD,OBS_VALUE\n2099-01-01,48.00\n2099-01-02,50.00\n";
      return new Response(csv, { status: 200 });
    });
    const provider = new EcbRateProvider({ fetchImpl });
    expect(await provider.getRate("USD", "UAH", "2099-01-03")).toEqual({ rate: "40", publicationDate: "2099-01-02", source: "ECB" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("derives an NBU cross-rate and walks back to the last published day", async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const parsed = new URL(url);
      const date = parsed.searchParams.get("date");
      const currency = parsed.searchParams.get("valcode");
      if (date === "20990103") return new Response("[]", { status: 200 });
      const rate = currency === "USD" ? 40 : 50;
      return new Response(JSON.stringify([{ rate, exchangedate: "02.01.2099" }]), { status: 200 });
    });
    const provider = new NbuRateProvider({ fetchImpl });
    expect(await provider.getRate("EUR", "USD", "2099-01-03")).toEqual({ rate: "1.25", publicationDate: "2099-01-02", source: "NBU" });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("does not manufacture a rate when official responses are missing or malformed", async () => {
    const missing = new NbuRateProvider({ fetchImpl: async () => new Response("[]", { status: 200 }) });
    expect(await missing.getRate("USD", "UAH", "2099-01-03")).toBeNull();
    const malformed = new EcbRateProvider({ fetchImpl: async () => new Response("SYNTHETIC INVALID", { status: 200 }) });
    expect(await malformed.getRate("USD", "UAH", "2099-01-03")).toBeNull();
  });

  it("loads an ECB date range in one request and resolves the latest common publication", async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      void url;
      return new Response([
        "CURRENCY,TIME_PERIOD,OBS_VALUE",
        "USD,2099-01-01,1.20",
        "UAH,2099-01-01,48.00",
        "USD,2099-01-02,1.25",
        "UAH,2099-01-02,50.00",
      ].join("\n"), { status: 200 });
    });
    const edges = await new EcbHistoricalRateLoader({ fetchImpl }).load({
      currencies: ["UAH", "EUR", "USD"],
      startDate: "2099-01-01",
      endDate: "2099-01-03",
    });
    const book = new HistoricalRateBook(edges);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(new URL(fetchImpl.mock.calls[0]![0] as string | URL).searchParams.get("startPeriod")).toBe("2099-01-01");
    expect(book.resolve("USD", "UAH", "2099-01-03")).toEqual({
      rate: "40",
      publicationDate: "2099-01-02",
      source: "ECB",
    });
  });

  it("loads NBU date ranges per currency, honors rate_per_unit, and prefers ECB evidence", async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const currency = new URL(url).searchParams.get("valcode")?.toUpperCase();
      return new Response(JSON.stringify([
        {
          cc: currency,
          exchangedate: "02.01.2099",
          rate: currency === "USD" ? 80 : 50,
          units: currency === "USD" ? 2 : 1,
          rate_per_unit: currency === "USD" ? 40 : 50,
        },
      ]), { status: 200 });
    });
    const nbuEdges = await new NbuHistoricalRateLoader({ fetchImpl }).load({
      currencies: ["UAH", "EUR", "USD"],
      startDate: "2099-01-01",
      endDate: "2099-01-03",
    });
    const book = new HistoricalRateBook([
      ...nbuEdges,
      { base: "EUR", quote: "USD", rate: "1.2", publicationDate: "2099-01-02", source: "ECB" },
    ]);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(book.resolve("USD", "UAH", "2099-01-03")).toEqual({
      rate: "40",
      publicationDate: "2099-01-02",
      source: "NBU",
    });
    expect(book.resolve("EUR", "USD", "2099-01-03")).toEqual({
      rate: "1.2",
      publicationDate: "2099-01-02",
      source: "ECB",
    });
    expect(book.resolve("USD", "USD", "2099-01-03")).toEqual({
      rate: "1",
      publicationDate: "2099-01-03",
      source: "identity",
    });
    expect(book.resolve("GBP", "UAH", "2099-01-03")).toBeNull();
  });
});

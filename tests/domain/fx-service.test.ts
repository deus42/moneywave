import { describe, expect, it } from "vitest";

import { FxService, InMemoryFxRateCache, type OfficialRateProvider } from "@/domain/fx-service";

function provider(name: "ECB" | "NBU", result: Awaited<ReturnType<OfficialRateProvider["getRate"]>>): OfficialRateProvider {
  return { name, getRate: async () => result };
}

describe("FX rate resolution", () => {
  it("uses a transaction-provided executed rate before official providers", async () => {
    let calls = 0;
    const ecb: OfficialRateProvider = { name: "ECB", getRate: async () => { calls += 1; return null; } };
    const service = new FxService({ ecb, nbu: provider("NBU", null), cache: new InMemoryFxRateCache() });
    const result = await service.resolve({ base: "USD", quote: "UAH", onOrBeforeDate: "2099-01-03", transactionRate: "40.125" });
    expect(result).toEqual({ rate: "40.125", source: "transaction", publicationDate: "2099-01-03" });
    expect(calls).toBe(0);
  });

  it("uses ECB then NBU and caches the selected official publication evidence", async () => {
    let ecbCalls = 0;
    const ecb: OfficialRateProvider = {
      name: "ECB",
      getRate: async () => {
        ecbCalls += 1;
        return { rate: "40.50", publicationDate: "2099-01-02", source: "ECB" };
      },
    };
    const cache = new InMemoryFxRateCache();
    const service = new FxService({ ecb, nbu: provider("NBU", { rate: "40.40", publicationDate: "2099-01-02", source: "NBU" }), cache });
    expect(await service.benchmark({ base: "USD", quote: "UAH", onOrBeforeDate: "2099-01-03" }))
      .toEqual({ rate: "40.5", publicationDate: "2099-01-02", source: "ECB" });
    expect(await service.benchmark({ base: "USD", quote: "UAH", onOrBeforeDate: "2099-01-03" }))
      .toEqual({ rate: "40.5", publicationDate: "2099-01-02", source: "ECB" });
    expect(ecbCalls).toBe(1);
  });

  it("falls back to NBU but returns a warning error when neither source has a rate", async () => {
    const fallback = new FxService({
      ecb: provider("ECB", null),
      nbu: provider("NBU", { rate: "40.40", publicationDate: "2099-01-01", source: "NBU" }),
      cache: new InMemoryFxRateCache(),
    });
    expect(await fallback.benchmark({ base: "USD", quote: "UAH", onOrBeforeDate: "2099-01-03" }))
      .toMatchObject({ rate: "40.4", source: "NBU", publicationDate: "2099-01-01" });

    const missing = new FxService({ ecb: provider("ECB", null), nbu: provider("NBU", null), cache: new InMemoryFxRateCache() });
    await expect(missing.benchmark({ base: "USD", quote: "UAH", onOrBeforeDate: "2099-01-03" })).rejects.toThrow("FX_RATE_UNAVAILABLE");
  });
});

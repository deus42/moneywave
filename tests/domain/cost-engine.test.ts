import { describe, expect, it } from "vitest";

import { analyzeFxCost, analyzeSameCurrencyCost } from "@/domain/cost-engine";

describe("cost engine", () => {
  it("conserves same-currency movements exactly and distinguishes confirmed from unexplained gaps", () => {
    const confirmed = analyzeSameCurrencyCost({
      currency: "UAH",
      sourceDebitsMinor: [10_000n],
      destinationCreditsMinor: [9_800n],
      explicitFeesMinor: [100n],
      manualCostsMinor: [50n],
      confirmResidualAsTransferGap: true,
    });
    expect(confirmed.components).toEqual([
      { method: "explicit_statement_fee", amountMinor: 100n, currency: "UAH", estimated: false },
      { method: "manual_cost", amountMinor: 50n, currency: "UAH", estimated: false },
      { method: "same_currency_transfer_gap", amountMinor: 50n, currency: "UAH", estimated: false },
    ]);
    expect(confirmed).toMatchObject({ reconciled: true, residualMinor: 0n });

    const unexplained = analyzeSameCurrencyCost({
      currency: "UAH",
      sourceDebitsMinor: [10_000n],
      destinationCreditsMinor: [9_800n],
      explicitFeesMinor: [100n],
      manualCostsMinor: [50n],
      confirmResidualAsTransferGap: false,
    });
    expect(unexplained.components.at(-1)).toMatchObject({ method: "unexplained_gap", amountMinor: 50n });
    expect(unexplained.reconciled).toBe(false);
  });

  it("rejects an impossible over-credit instead of calling it a fee", () => {
    const result = analyzeSameCurrencyCost({
      currency: "UAH",
      sourceDebitsMinor: [9_900n],
      destinationCreditsMinor: [10_000n],
      explicitFeesMinor: [],
      confirmResidualAsTransferGap: true,
    });
    expect(result.reconciled).toBe(false);
    expect(result.components).toEqual([{ method: "unexplained_gap", amountMinor: -100n, currency: "UAH", estimated: false }]);
  });

  it("calculates FX spread from decimal text and does not double-count an explicit fee", () => {
    const result = analyzeFxCost({
      sold: { amountMinor: 10_000n, currency: "USD" },
      received: { amountMinor: 400_000n, currency: "UAH" },
      benchmarkRate: "40.50",
      benchmarkSource: "NBU",
      publicationDate: "2099-01-01",
      explicitFeeMinor: 2_000n,
      manualCostMinor: 1_000n,
    });

    expect(result.executedRate).toBe("40");
    expect(result.benchmarkAmountMinor).toBe(405_000n);
    expect(result.totalFxCostMinor).toBe(5_000n);
    expect(result.components).toEqual([
      { method: "explicit_statement_fee", amountMinor: 2_000n, currency: "UAH", estimated: false },
      { method: "manual_cost", amountMinor: 1_000n, currency: "UAH", estimated: false },
      { method: "fx_spread_estimate", amountMinor: 2_000n, currency: "UAH", estimated: true },
    ]);
    expect(result.auditEvidence).toMatchObject({ benchmarkSource: "NBU", publicationDate: "2099-01-01" });
  });

  it("requires a real benchmark and never falls back to 1:1", () => {
    expect(() => analyzeFxCost({
      sold: { amountMinor: 10_000n, currency: "USD" },
      received: { amountMinor: 400_000n, currency: "UAH" },
      benchmarkRate: null,
      benchmarkSource: null,
      publicationDate: null,
      explicitFeeMinor: 0n,
    })).toThrow("FX_BENCHMARK_MISSING");
  });
});

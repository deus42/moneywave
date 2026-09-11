import { describe, expect, it } from "vitest";

import { parsePrivatFxDescription } from "@/domain/privat-fx-evidence";

describe("Privat FX description evidence", () => {
  it("extracts the provider-stated sold amount, currency, and rate", () => {
    expect(parsePrivatFxDescription("SYNTHETIC: Гривнi вiд продажу 1 000,50 USD по курсу 40,1234"))
      .toEqual({ soldAmountMinor: 100_050n, soldCurrency: "USD", statedRate: "40.1234" });
  });

  it("does not infer FX from an ordinary description", () => {
    expect(parsePrivatFxDescription("SYNTHETIC PAYMENT 100 USD")).toBeNull();
    expect(parsePrivatFxDescription("Гривні від продажу INVALID USD по курсу 40")).toBeNull();
  });
});

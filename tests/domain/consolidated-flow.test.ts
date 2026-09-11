import { describe, expect, it } from "vitest";

import { calculateConsolidatedFlow } from "@/domain/consolidated-flow";

describe("consolidated FOP and personal flow", () => {
  it("counts gross income and terminal costs once while excluding owner draw, transfers, and FX legs", () => {
    const result = calculateConsolidatedFlow([
      { amountMinor: 100_000n, currency: "UAH", entryKind: "business_income" },
      { amountMinor: -20_000n, currency: "UAH", entryKind: "tax" },
      { amountMinor: -5_000n, currency: "UAH", entryKind: "mandatory_payment" },
      { amountMinor: -10_000n, currency: "UAH", entryKind: "business_expense" },
      { amountMinor: -50_000n, currency: "UAH", entryKind: "owner_draw" },
      { amountMinor: 50_000n, currency: "UAH", entryKind: "transfer_in" },
      { amountMinor: -25_000n, currency: "UAH", entryKind: "transfer_out" },
      { amountMinor: -100n, currency: "USD", entryKind: "fx_sell" },
      { amountMinor: 4_000n, currency: "UAH", entryKind: "fx_buy" },
      { amountMinor: -12_000n, currency: "UAH", entryKind: "terminal_personal_expense" },
      { amountMinor: -100n, currency: "UAH", entryKind: "explicit_fee" },
    ]);

    expect(result).toEqual([
      {
        currency: "UAH",
        grossIncomeMinor: 100_000n,
        spendingMinor: 47_100n,
        internalMovementMinor: 79_000n,
      },
      {
        currency: "USD",
        grossIncomeMinor: 0n,
        spendingMinor: 0n,
        internalMovementMinor: 100n,
      },
    ]);
  });
});

import { describe, expect, it, vi } from "vitest";

import { reconcileToFixedPoint } from "@/server/reconciliation/fixed-point";

describe("autonomous reconciliation fixed point", () => {
  it("keeps resolving globally unique pairs until a pass adds no groups", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ confirmed: 2, rejectedCandidates: 4, pendingCandidates: 0, ambiguousEntries: 5, unmatchedEntries: 7, unexplainedGaps: 0, fxConversions: 1 })
      .mockResolvedValueOnce({ confirmed: 1, rejectedCandidates: 0, pendingCandidates: 0, ambiguousEntries: 2, unmatchedEntries: 4, unexplainedGaps: 1, fxConversions: 0 })
      .mockResolvedValueOnce({ confirmed: 0, rejectedCandidates: 0, pendingCandidates: 0, ambiguousEntries: 1, unmatchedEntries: 3, unexplainedGaps: 0, fxConversions: 0 });

    expect(await reconcileToFixedPoint({ run })).toEqual({
      confirmed: 3,
      rejectedCandidates: 4,
      pendingCandidates: 0,
      ambiguousEntries: 1,
      unmatchedEntries: 3,
      unexplainedGaps: 1,
      fxConversions: 1,
      iterations: 3,
    });
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("fails safely instead of looping forever", async () => {
    await expect(reconcileToFixedPoint({ run: async () => ({ confirmed: 1, rejectedCandidates: 0, pendingCandidates: 0, ambiguousEntries: 0, unmatchedEntries: 0, unexplainedGaps: 0, fxConversions: 0 }) }, 2))
      .rejects.toThrow("AUTONOMOUS_RECONCILIATION_DID_NOT_CONVERGE");
  });
});

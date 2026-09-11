import { describe, expect, it, vi } from "vitest";

import { runAutonomousAnalysis } from "@/server/analysis/autonomous-analysis";

describe("autonomous analysis orchestration", () => {
  it("runs evidence recovery, global matching, classification, and categorization in order", async () => {
    const order: string[] = [];
    const stage = <T>(name: string, result: T) => vi.fn(async () => {
      order.push(name);
      return result;
    });
    const stages = {
      recoverUndated: stage("undated", { resolved: 2 }),
      repairAutomaticFx: stage("fx-repair", { revoked: 1 }),
      materializeProviderFx: stage("provider-fx", { confirmed: 2 }),
      prepareClassifications: stage("classification-preparation", { resetEntries: 3 }),
      discoverMovements: stage("movement-discovery", { candidates: 4 }),
      reconcileMovements: stage("global-reconciliation", { confirmed: 3, pendingCandidates: 0 }),
      analyzeCosts: stage("cost-analysis", { fxBenchmarked: 1 }),
      classifyEntries: stage("classification", { classified: 7 }),
      categorizePersonalEntries: stage("categorization", { assigned: 5 }),
    };

    const result = await runAutonomousAnalysis(stages);

    expect(order).toEqual([
      "undated",
      "fx-repair",
      "provider-fx",
      "classification-preparation",
      "movement-discovery",
      "global-reconciliation",
      "cost-analysis",
      "classification",
      "categorization",
    ]);
    expect(result.reconciliation).toEqual({ confirmed: 3, pendingCandidates: 0 });
    expect(result.repair).toEqual({ revoked: 1 });
    expect(result.providerFx).toEqual({ confirmed: 2 });
    expect(result.preparation).toEqual({ resetEntries: 3 });
    expect(result.costs).toEqual({ fxBenchmarked: 1 });
    expect(result.categorization).toEqual({ assigned: 5 });
  });

  it("does not classify or categorize when reconciliation fails", async () => {
    const classifyEntries = vi.fn(async () => ({ classified: 0 }));
    const categorizePersonalEntries = vi.fn(async () => ({ assigned: 0 }));

    await expect(runAutonomousAnalysis({
      recoverUndated: async () => ({ resolved: 0 }),
      repairAutomaticFx: async () => ({ revoked: 0 }),
      materializeProviderFx: async () => ({ confirmed: 0 }),
      prepareClassifications: async () => ({ resetEntries: 0 }),
      discoverMovements: async () => ({ candidates: 0 }),
      reconcileMovements: async () => { throw new Error("AUTONOMOUS_RECONCILIATION_FAILED"); },
      analyzeCosts: async () => ({ fxBenchmarked: 0 }),
      classifyEntries,
      categorizePersonalEntries,
    })).rejects.toThrow("AUTONOMOUS_RECONCILIATION_FAILED");

    expect(classifyEntries).not.toHaveBeenCalled();
    expect(categorizePersonalEntries).not.toHaveBeenCalled();
  });
});

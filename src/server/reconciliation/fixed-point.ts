import type { AutonomousReconciliationResult } from "@/server/reconciliation/autonomous-service";

interface ReconciliationRunner {
  run(): Promise<AutonomousReconciliationResult>;
}

export interface FixedPointReconciliationResult extends AutonomousReconciliationResult {
  iterations: number;
}

export async function reconcileToFixedPoint(
  runner: ReconciliationRunner,
  maximumIterations = 100,
): Promise<FixedPointReconciliationResult> {
  if (!Number.isSafeInteger(maximumIterations) || maximumIterations < 1) throw new Error("AUTONOMOUS_ITERATION_LIMIT_INVALID");
  const totals = { confirmed: 0, rejectedCandidates: 0, unexplainedGaps: 0, fxConversions: 0 };
  for (let iteration = 1; iteration <= maximumIterations; iteration += 1) {
    const result = await runner.run();
    totals.confirmed += result.confirmed;
    totals.rejectedCandidates += result.rejectedCandidates;
    totals.unexplainedGaps += result.unexplainedGaps;
    totals.fxConversions += result.fxConversions;
    if (result.confirmed === 0) {
      return {
        ...totals,
        pendingCandidates: result.pendingCandidates,
        ambiguousEntries: result.ambiguousEntries,
        unmatchedEntries: result.unmatchedEntries,
        iterations: iteration,
      };
    }
  }
  throw new Error("AUTONOMOUS_RECONCILIATION_DID_NOT_CONVERGE");
}

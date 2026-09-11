import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { executeVerifiedAnalysis } from "../src/server/analysis/verified-run";
import { enforceBackupRetention } from "../src/server/db/backup-retention";
import { createVerifiedBackup } from "../src/server/db/backup";
import { getDatabase, getSecretStore, refreshDerivedState } from "../src/server/runtime/services";
import { resolveMoneyWavePaths } from "../src/server/runtime/paths";

function safeTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function errorCode(error: unknown): string {
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(error.message)) return error.message;
  return "AUTONOMOUS_ANALYSIS_FAILED";
}

const database = await getDatabase();
const key = await getSecretStore().get("database-key");
const paths = resolveMoneyWavePaths();

try {
  const result = await executeVerifiedAnalysis({
    database,
    createBackup: async () => {
      await createVerifiedBackup({
        database,
        destinationPath: join(paths.backupDirectory, `before-analysis-${safeTimestamp()}-${randomUUID()}.backup`),
        key,
        reason: "manual",
      });
      await enforceBackupRetention(paths.backupDirectory);
    },
    analyze: refreshDerivedState,
  });
  const { undated, repair, providerFx, preparation, movements, reconciliation, costs, classification, categorization } = result.analysis;
  process.stdout.write("backup PASS\n");
  process.stdout.write(`undated PASS resolved=${undated.resolvedRows} ambiguous=${undated.ambiguousRows} pending=${undated.pendingRows}\n`);
  process.stdout.write(`fx_link_validation PASS checked=${repair.checked} revoked=${repair.revoked} retained=${repair.retained}\n`);
  process.stdout.write(`provider_fx_evidence PASS parsed=${providerFx.parsed} confirmed=${providerFx.confirmed} invalid=${providerFx.invalid} replaced=${providerFx.revoked}\n`);
  process.stdout.write(`classification_preparation PASS reset=${preparation.resetEntries} assignments_removed=${preparation.removedAutomaticAssignments}\n`);
  process.stdout.write(`movement_discovery PASS confirmed=${movements.confirmedCreated} candidates=${movements.candidatesCreated} unlinked=${movements.unlinked}\n`);
  process.stdout.write(`movement_resolution PASS iterations=${reconciliation.iterations} confirmed=${reconciliation.confirmed} rejected=${reconciliation.rejectedCandidates} pending=${reconciliation.pendingCandidates} ambiguous=${reconciliation.ambiguousEntries} unmatched=${reconciliation.unmatchedEntries}\n`);
  process.stdout.write(`cost_analysis PASS exact=${costs.exactGroupsReconciled} fx=${costs.fxBenchmarked} unavailable=${costs.fxBenchmarkUnavailable}\n`);
  process.stdout.write(`entry_classification PASS classified=${classification.classified} insufficient_evidence=${classification.heldForReview}\n`);
  process.stdout.write(`categorization PASS assigned=${categorization.assigned} deterministic=${categorization.deterministic} bank=${categorization.bank} merchant=${categorization.merchantHeuristic} openai=${categorization.openaiCodex} pending_openai=${categorization.pendingOpenAI}\n`);
  process.stdout.write(`database_integrity PASS foreign_keys=${result.foreignKeys}\n`);
  if (categorization.pendingOpenAI > 0) process.exitCode = 2;
} catch (error) {
  process.stdout.write(`analysis FAIL ${errorCode(error)}\n`);
  process.exitCode = 1;
} finally {
  key.fill(0);
  await database.close().catch(() => undefined);
}

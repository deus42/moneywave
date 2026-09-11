import type { EncryptedDatabase } from "@/server/db/database";

export async function executeVerifiedAnalysis<Result>(input: {
  database: EncryptedDatabase;
  createBackup(): Promise<void>;
  analyze(): Promise<Result>;
}): Promise<{ analysis: Result; integrity: "ok"; foreignKeys: "ok" }> {
  await input.createBackup();
  const analysis = await input.analyze();
  const integrity = await input.database.get<{ integrity_check: string }>("PRAGMA integrity_check");
  if (integrity?.integrity_check !== "ok") throw new Error("DATABASE_INTEGRITY_FAILED");
  const foreignKeyViolations = await input.database.all<Record<string, unknown>>("PRAGMA foreign_key_check");
  if (foreignKeyViolations.length > 0) throw new Error("DATABASE_FOREIGN_KEY_FAILED");
  return { analysis, integrity: "ok", foreignKeys: "ok" };
}

export async function executeVerifiedFinanceRun<Artifact, CashResult, AnalysisResult, ValuationResult>(input: {
  database: EncryptedDatabase;
  artifacts: readonly Artifact[];
  createBackup(): Promise<void>;
  importArtifact(artifact: Artifact): Promise<"imported" | "already_imported">;
  initializeCash(): Promise<CashResult>;
  analyze(): Promise<AnalysisResult>;
  materializeValuations(): Promise<ValuationResult>;
}): Promise<{
  analysis: {
    importedArtifacts: number;
    alreadyImportedArtifacts: number;
    cash: CashResult;
    derived: AnalysisResult;
    valuations: ValuationResult;
  };
  integrity: "ok";
  foreignKeys: "ok";
}> {
  if (input.artifacts.length === 0) throw new Error("FINANCE_IMPORT_ARTIFACTS_EMPTY");
  return executeVerifiedAnalysis({
    database: input.database,
    createBackup: input.createBackup,
    analyze: async () => {
      let importedArtifacts = 0;
      let alreadyImportedArtifacts = 0;
      for (const artifact of input.artifacts) {
        const status = await input.importArtifact(artifact);
        if (status === "imported") importedArtifacts += 1;
        else alreadyImportedArtifacts += 1;
      }
      const cash = await input.initializeCash();
      const derived = await input.analyze();
      const valuations = await input.materializeValuations();
      return { importedArtifacts, alreadyImportedArtifacts, cash, derived, valuations };
    },
  });
}

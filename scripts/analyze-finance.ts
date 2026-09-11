import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { executeVerifiedFinanceRun } from "../src/server/analysis/verified-run";
import { CashService } from "../src/server/cash/service";
import { enforceBackupRetention } from "../src/server/db/backup-retention";
import { createVerifiedBackup } from "../src/server/db/backup";
import type { ImportAccountRegistration } from "../src/server/import/repository";
import type { ImportPreviewIdentifier } from "../src/server/import/service";
import { resolveMoneyWavePaths } from "../src/server/runtime/paths";
import { withZeroedBuffer } from "../src/server/security/sensitive-buffer";
import {
  getDatabase,
  getSecretStore,
  refreshDerivedState,
  refreshReportingValuations,
  withImportService,
} from "../src/server/runtime/services";

const EXPECTED_MONOBANK_ARTIFACTS = 3;
const CASH_OPENING_DATE = "2024-09-04";

function safeTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function errorCode(error: unknown): string {
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/u.test(error.message)) return error.message;
  return "FINANCE_ANALYSIS_FAILED";
}

function stableLocalId(prefix: string, hash: string): string {
  if (!/^[a-f0-9]{64}$/u.test(hash)) throw new Error("ACCOUNT_IDENTIFIER_HASH_INVALID");
  return `${prefix}-${hash.slice(0, 24)}`;
}

const paths = resolveMoneyWavePaths();
const inbox = join(process.cwd(), "data", "monobank");
const inputs = (await readdir(inbox, { withFileTypes: true }).catch(() => []))
  .filter((entry) => entry.isFile() && !entry.name.startsWith("~$") && /\.(?:csv|xls|xlsx)$/iu.test(entry.name))
  .map((entry) => join(inbox, entry.name))
  .sort();

if (inputs.length !== EXPECTED_MONOBANK_ARTIFACTS) {
  process.stdout.write("finance_import FAIL MONOBANK_ARTIFACT_COUNT_INVALID\n");
  process.exitCode = 1;
} else {
  const database = await getDatabase();
  const key = await getSecretStore().get("database-key");
  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = () => undefined;
  console.error = () => undefined;

  async function registrationFor(identifier: ImportPreviewIdentifier): Promise<ImportAccountRegistration> {
    if (identifier.identifierKind !== "account" || !identifier.instrumentIdentifierHash || !identifier.instrumentDisplay) {
      throw new Error("MONOBANK_ACCOUNT_DISCOVERY_INVALID");
    }
    const currency = identifier.currencies[0];
    if (!currency || identifier.currencies.length !== 1) throw new Error("OWNERSHIP_MAPPING_CURRENCY_CONFLICT");
    const existingAccount = await database.get<{
      id: string;
      displayName: string;
      ownerScope: "PERSONAL" | "SOLE_PROPRIETOR";
      accountType: string;
      currency: string;
      providerCode: string;
    }>(`
      SELECT account.id, account.display_name AS displayName, account.owner_scope AS ownerScope,
        account.account_type AS accountType, account.currency, provider.code AS providerCode
      FROM accounts account
      JOIN providers provider ON provider.id = account.provider_id
      WHERE account.identifier_hmac = ?
    `, [identifier.identifierHash]);
    if (existingAccount && (
      existingAccount.providerCode !== "monobank"
      || existingAccount.ownerScope !== "PERSONAL"
      || existingAccount.currency !== currency
    )) throw new Error("ACCOUNT_MAPPING_CONFLICT");
    const existingInstrument = await database.get<{ id: string; accountId: string }>(`
      SELECT id, account_id AS accountId FROM account_instruments WHERE identifier_hmac = ?
    `, [identifier.instrumentIdentifierHash]);
    const accountId = existingAccount?.id ?? stableLocalId("monobank-account", identifier.identifierHash);
    if (existingInstrument && existingInstrument.accountId !== accountId) throw new Error("INSTRUMENT_MAPPING_CONFLICT");
    return {
      accountId,
      displayName: existingAccount?.displayName ?? `Monobank ${currency} · ${identifier.display}`,
      ownerScope: "PERSONAL",
      accountType: existingAccount?.accountType ?? "card",
      currency,
      identifierHash: identifier.identifierHash,
      identifierKind: "account",
      instrumentId: existingInstrument?.id ?? stableLocalId("monobank-instrument", identifier.instrumentIdentifierHash),
      instrumentIdentifierHash: identifier.instrumentIdentifierHash,
      instrumentMaskedDisplay: identifier.instrumentDisplay,
      maskedDisplay: identifier.display,
    };
  }

  async function importArtifact(path: string): Promise<"imported" | "already_imported"> {
    const bytes = await readFile(path);
    return withZeroedBuffer(bytes, async (artifactBytes) => {
      const sha256 = createHash("sha256").update(artifactBytes).digest("hex");
      const existing = await database.get<{ present: number }>("SELECT 1 AS present FROM import_artifacts WHERE sha256 = ?", [sha256]);
      if (existing?.present === 1) return "already_imported";
      return await withImportService(async (service) => {
        const preview = await service.preview(artifactBytes);
        if (preview.providerCode !== "monobank" || preview.parserKind !== "monobank_personal") {
          await service.rollback(preview.previewId);
          throw new Error("MONOBANK_FORMAT_INVALID");
        }
        const registrations: ImportAccountRegistration[] = [];
        for (const identifier of preview.identifiers) registrations.push(await registrationFor(identifier));
        const committed = await service.commit({ previewId: preview.previewId, mappingComplete: true, registrations });
        if (committed.backupStatus !== "verified") throw new Error("IMPORT_BACKUP_FAILED");
        return "imported" as const;
      });
    });
  }

  try {
    const result = await executeVerifiedFinanceRun({
      database,
      artifacts: inputs,
      createBackup: async () => {
        await createVerifiedBackup({
          database,
          destinationPath: join(paths.backupDirectory, `before-finance-${safeTimestamp()}-${randomUUID()}.backup`),
          key,
          reason: "manual",
        });
        await enforceBackupRetention(paths.backupDirectory);
      },
      importArtifact,
      initializeCash: () => new CashService(database).run({ openingDate: CASH_OPENING_DATE, currencies: ["UAH", "EUR", "USD"] }),
      analyze: refreshDerivedState,
      materializeValuations: refreshReportingValuations,
    });
    await createVerifiedBackup({
      database,
      destinationPath: join(paths.backupDirectory, `after-finance-${safeTimestamp()}-${randomUUID()}.backup`),
      key,
      reason: "after_import",
    });
    await enforceBackupRetention(paths.backupDirectory);

    const { derived, cash, valuations } = result.analysis;
    process.stdout.write("backup PASS\n");
    process.stdout.write(`finance_import PASS imported=${result.analysis.importedArtifacts} existing=${result.analysis.alreadyImportedArtifacts}\n`);
    process.stdout.write(`cash_position PASS accounts=${cash.accountsInitialized} movements=${cash.movementsCreated}\n`);
    process.stdout.write(`movement_resolution PASS confirmed=${derived.reconciliation.confirmed} pending=${derived.reconciliation.pendingCandidates} ambiguous=${derived.reconciliation.ambiguousEntries} unmatched=${derived.reconciliation.unmatchedEntries}\n`);
    process.stdout.write(`cost_analysis PASS exact=${derived.costs.exactGroupsReconciled} provider_fees=${derived.costs.providerFeesRecorded} unavailable=${derived.costs.fxBenchmarkUnavailable}\n`);
    process.stdout.write(`categorization PASS assigned=${derived.categorization.assigned} alias=${derived.categorization.alias} mcc=${derived.categorization.mcc} openai=${derived.categorization.openaiCodex} pending=${derived.categorization.pendingOpenAI}\n`);
    process.stdout.write(`valuations PASS entries=${valuations.entryValuations} balances=${valuations.balanceValuations} costs=${valuations.costValuations} fx_sources=${valuations.fxSourceValuations} missing=${valuations.missingRateCount}\n`);
    process.stdout.write(`database_integrity PASS foreign_keys=${result.foreignKeys}\n`);
    if (derived.categorization.pendingOpenAI > 0 || derived.reconciliation.pendingCandidates > 0) process.exitCode = 2;
  } catch (error) {
    process.stdout.write(`finance_import FAIL ${errorCode(error)}\n`);
    process.exitCode = 1;
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
    key.fill(0);
    await database.close().catch(() => undefined);
  }
}

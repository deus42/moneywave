import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { enforceBackupRetention } from "@/server/db/backup-retention";
import { createVerifiedBackup } from "@/server/db/backup";
import { initializeMoneyWaveDatabase } from "@/server/db/bootstrap";
import type { EncryptedDatabase } from "@/server/db/database";
import { PrivatFopJournalAdapter } from "@/server/import/privat-fop";
import { PrivatPersonalStatementAdapter } from "@/server/import/privat-personal";
import { RevolutStatementAdapter } from "@/server/import/revolut";
import { WiseStatementAdapter } from "@/server/import/wise";
import { ErsteStatementAdapter } from "@/server/import/erste";
import { MonobankStatementAdapter } from "@/server/import/monobank";
import { createStatementImportAdapter } from "@/server/import/adapter";
import { SecurePreviewStore } from "@/server/import/preview-store";
import { ImportRepository } from "@/server/import/repository";
import { ImportService } from "@/server/import/service";
import { CostService } from "@/server/movements/cost-service";
import { AutonomousCostService } from "@/server/movements/autonomous-cost-service";
import { MovementService } from "@/server/movements/service";
import { runAutonomousAnalysis } from "@/server/analysis/autonomous-analysis";
import {saveWorkspaceCategoryRules} from "@/server/workspace/processing-rules";
import {CategoryPolicyService} from "@/server/categorization/category-policy-service";
import { AutonomousCategorizationService } from "@/server/categorization/autonomous-service";
import { EntryClassificationService } from "@/server/categorization/entry-classification";
import { ReclassificationPreparationService } from "@/server/categorization/reclassification-preparation";
import { CategorizationApplicationService } from "@/server/categorization/application-service";
import { CodexSubscriptionCategorizer } from "@/server/categorization/codex-subscription";
import { FxService } from "@/domain/fx-service";
import { DatabaseFxRateCache } from "@/server/fx/database-cache";
import { HistoricalRateBook } from "@/server/fx/historical-rates";
import { EcbHistoricalRateLoader, EcbRateProvider, NbuHistoricalRateLoader, NbuRateProvider } from "@/server/fx/official-providers";
import { ValuationService } from "@/server/fx/valuation-service";
import { MoneyWaveReadRepository } from "@/server/read-model/repository";
import { AutonomousReconciliationService } from "@/server/reconciliation/autonomous-service";
import { AutomaticFxRepairService } from "@/server/reconciliation/automatic-fx-repair";
import { ProviderFxEvidenceService } from "@/server/reconciliation/provider-fx-evidence";
import { reconcileToFixedPoint } from "@/server/reconciliation/fixed-point";
import { UndatedReconciliationService } from "@/server/reconciliation/undated-service";
import { MacKeychainStore } from "@/server/secrets/keychain-store";
import { deriveIdentifierHmacKey } from "@/server/secrets/key-derivation";
import { RecoverySetup } from "@/server/secrets/recovery-setup";
import { resolveMoneyWavePaths } from "./paths";

interface RuntimeSingletons {
  database?: Promise<EncryptedDatabase>;
  previewStore?: SecurePreviewStore;
  recoverySetup?: RecoverySetup;
}

const runtime = globalThis as typeof globalThis & { __moneywaveRuntime?: RuntimeSingletons };
const singletons = runtime.__moneywaveRuntime ?? {};
runtime.__moneywaveRuntime = singletons;

function safeTimestamp(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

export function getSecretStore(): MacKeychainStore {
  const paths = resolveMoneyWavePaths();
  return new MacKeychainStore({
    helperPath: paths.keychainHelperPath,
    service: process.env.MONEYWAVE_KEYCHAIN_SERVICE ?? "app.moneywave.local",
  });
}

export function getRecoverySetup(): RecoverySetup {
  singletons.recoverySetup ??= new RecoverySetup(getSecretStore());
  return singletons.recoverySetup;
}

export async function getSetupStatus(): Promise<{ configured: boolean }> {
  const store = getSecretStore();
  return { configured: await store.has("database-key") };
}

export async function getDatabase(): Promise<EncryptedDatabase> {
  if (!singletons.database) {
    singletons.database = (async () => {
      const paths = resolveMoneyWavePaths();
      const key = await getSecretStore().get("database-key");
      try {
        const initialized = await initializeMoneyWaveDatabase({
          databasePath: paths.databasePath,
          backupDirectory: paths.backupDirectory,
          key,
        });
        return initialized.database;
      } finally {
        key.fill(0);
      }
    })().catch((error) => {
      singletons.database = undefined;
      throw error;
    });
  }
  return singletons.database;
}

function getPreviewStore(): SecurePreviewStore {
  const paths = resolveMoneyWavePaths();
  singletons.previewStore ??= new SecurePreviewStore(paths.previewDirectory);
  return singletons.previewStore;
}

async function backupAfterImport(batchId: string): Promise<{ integrity: "ok" }> {
  if (!/^[0-9a-f-]{36}$/i.test(batchId)) throw new Error("IMPORT_BATCH_ID_INVALID");
  const paths = resolveMoneyWavePaths();
  const key = await getSecretStore().get("database-key");
  try {
    const manifest = await createVerifiedBackup({
      database: await getDatabase(),
      destinationPath: join(paths.backupDirectory, `after-import-${safeTimestamp()}-${batchId}-${randomUUID()}.backup`),
      key,
      reason: "after_import",
    });
    await enforceBackupRetention(paths.backupDirectory);
    return { integrity: manifest.integrity };
  } finally {
    key.fill(0);
  }
}

export async function withImportService<T>(operation: (service: ImportService) => Promise<T>, options?: { wiseAccountIdentifier?: string; revolutAccountIdentifier?: string }): Promise<T> {
  const databaseKey = await getSecretStore().get("database-key");
  const identifierKey = deriveIdentifierHmacKey(databaseKey);
  try {
    const database = await getDatabase();
    const personal = new PrivatPersonalStatementAdapter({ identifierKey });
    const fop = new PrivatFopJournalAdapter({ identifierKey });
    const mono = new MonobankStatementAdapter({ identifierKey });
    const erste = new ErsteStatementAdapter({ identifierKey });
    const revolut = options?.revolutAccountIdentifier ? new RevolutStatementAdapter({ identifierKey, accountIdentifier: options.revolutAccountIdentifier }) : null;
    const wise = options?.wiseAccountIdentifier ? new WiseStatementAdapter({ identifierKey, accountIdentifier: options.wiseAccountIdentifier }) : null;
    const service = new ImportService({
      adapters: [
        ...(revolut ? [createStatementImportAdapter({
          providerCode: "revolut", providerDisplayName: "Revolut", parserKind: "revolut_personal",
          parserVersion: "revolut-personal@1", ownershipPolicy: "all_discovered", minimumPostedRows: 1,
          statement: revolut, discover: parsed => revolut.discoverAccounts(parsed), identifierKind: "account",
        })] : []),
        ...(wise ? [createStatementImportAdapter({
          providerCode: "wise", providerDisplayName: "Wise", parserKind: "wise_personal",
          parserVersion: "wise-personal@1", ownershipPolicy: "all_discovered", minimumPostedRows: 1,
          statement: wise, discover: parsed => wise.discoverAccounts(parsed), identifierKind: "account",
        })] : []),
        createStatementImportAdapter({
          providerCode: "erste", providerDisplayName: "Erste", parserKind: "erste_personal",
          parserVersion: "erste-personal@1", ownershipPolicy: "all_discovered", minimumPostedRows: 1,
          statement: erste, discover: parsed => erste.discoverAccounts(parsed), identifierKind: "account",
        }),
        createStatementImportAdapter({
          providerCode: "privatbank",
          providerDisplayName: "PrivatBank",
          parserKind: "privat_personal",
          parserVersion: "privat-personal@1",
          ownershipPolicy: "all_discovered",
          statement: personal,
          discover: (parsed) => personal.discoverInstruments(parsed),
          identifierKind: "instrument",
        }),
        createStatementImportAdapter({
          providerCode: "privatbank",
          providerDisplayName: "PrivatBank",
          parserKind: "privat_fop_journal",
          parserVersion: "privat-fop-journal@1",
          ownershipPolicy: "at_least_one",
          statement: fop,
          discover: (parsed) => fop.discoverAccounts(parsed),
          identifierKind: "account",
        }),
        createStatementImportAdapter({
          providerCode: "monobank",
          providerDisplayName: "Monobank",
          parserKind: "monobank_personal",
          parserVersion: "monobank-personal@1",
          ownershipPolicy: "all_discovered",
          minimumPostedRows: 1,
          statement: mono,
          discover: (parsed) => mono.discoverAccounts(parsed),
          identifierKind: "account",
        }),
      ],
      repository: new ImportRepository(database),
      previewStore: getPreviewStore(),
      backupAfterImport,
    });
    return await operation(service);
  } finally {
    identifierKey.fill(0);
    databaseKey.fill(0);
  }
}

export async function getMovementService(): Promise<MovementService> {
  return new MovementService(await getDatabase());
}

export async function getCostService(): Promise<CostService> {
  return new CostService(await getDatabase());
}

export async function getReadRepository(): Promise<MoneyWaveReadRepository> {
  return new MoneyWaveReadRepository(await getDatabase());
}

export async function getUndatedReconciliationService(): Promise<UndatedReconciliationService> {
  return new UndatedReconciliationService(await getDatabase());
}

export async function refreshDerivedState(): Promise<{
  undated: Awaited<ReturnType<UndatedReconciliationService["refresh"]>>;
  repair: Awaited<ReturnType<AutomaticFxRepairService["run"]>>;
  providerFx: Awaited<ReturnType<ProviderFxEvidenceService["run"]>>;
  preparation: Awaited<ReturnType<ReclassificationPreparationService["run"]>>;
  movements: Awaited<ReturnType<MovementService["refresh"]>>;
  reconciliation: Awaited<ReturnType<typeof reconcileToFixedPoint>>;
  costs: Awaited<ReturnType<AutonomousCostService["run"]>>;
  classification: Awaited<ReturnType<EntryClassificationService["refresh"]>>;
  categorization: Awaited<ReturnType<AutonomousCategorizationService["run"]>>;
}> {
  const database = await getDatabase();
  const fxService = await getFxService();
  await saveWorkspaceCategoryRules(database);
  await new CategoryPolicyService(database).apply();
  return runAutonomousAnalysis({
    recoverUndated: () => new UndatedReconciliationService(database).refresh(),
    repairAutomaticFx: () => new AutomaticFxRepairService(database).run(),
    materializeProviderFx: () => new ProviderFxEvidenceService(database).run(),
    prepareClassifications: () => new ReclassificationPreparationService(database).run(),
    discoverMovements: () => new MovementService(database).refresh(),
    reconcileMovements: () => reconcileToFixedPoint(new AutonomousReconciliationService(database, fxService)),
    analyzeCosts: () => new AutonomousCostService(database, fxService).run(),
    classifyEntries: () => new EntryClassificationService(database).refresh(),
    categorizePersonalEntries: () => new AutonomousCategorizationService(database, new CodexSubscriptionCategorizer()).run(),
  });
}

export async function getCategorizationService(): Promise<CategorizationApplicationService> {
  return new CategorizationApplicationService(await getDatabase(), new CodexSubscriptionCategorizer());
}

export async function getFxService(): Promise<FxService> {
  const database = await getDatabase();
  return new FxService({
    ecb: new EcbRateProvider(),
    nbu: new NbuRateProvider(),
    cache: new DatabaseFxRateCache(database),
  });
}

function shiftIsoDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new Error("FX_DATE_INVALID");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export async function refreshReportingValuations(): Promise<{
  entryValuations: number;
  balanceValuations: number;
  costValuations: number;
  fxSourceValuations: number;
  missingRateCount: number;
  unavailableSources: number;
}> {
  const database = await getDatabase();
  const bounds = await database.get<{ fromDate: string | null; toDate: string | null }>(`
    SELECT MIN(day) AS fromDate, MAX(day) AS toDate
    FROM (
      SELECT substr(occurred_at, 1, 10) AS day FROM ledger_entries
      UNION ALL
      SELECT substr(observed_at, 1, 10) AS day FROM balance_snapshots
    )
  `);
  if (!bounds?.fromDate || !bounds.toDate) {
    return { entryValuations: 0, balanceValuations: 0, costValuations: 0, fxSourceValuations: 0, missingRateCount: 0, unavailableSources: 0 };
  }
  const currencies = (await database.all<{ currency: string }>(`
    SELECT DISTINCT currency FROM (
      SELECT currency FROM ledger_entries
      UNION ALL SELECT currency FROM balance_snapshots
      UNION ALL SELECT currency FROM cost_components
    ) ORDER BY currency
  `)).map(({ currency }) => currency);
  const targetCurrencies = ["UAH", "EUR", "USD"] as const;

  let book = new HistoricalRateBook([]);
  const today = new Date().toISOString().slice(0, 10);
  let unavailableSources = 0;
  if (bounds.fromDate <= today) {
    const loaders = [new EcbHistoricalRateLoader(), new NbuHistoricalRateLoader()];
    const loaded = await Promise.allSettled(loaders.map((loader) => loader.load({
      currencies: [...new Set([...currencies, ...targetCurrencies])],
      startDate: shiftIsoDate(bounds.fromDate!, -14),
      endDate: bounds.toDate! < today ? bounds.toDate! : today,
    })));
    unavailableSources = loaded.filter(({ status }) => status === "rejected").length;
    book = new HistoricalRateBook(loaded.flatMap((result) => result.status === "fulfilled" ? result.value : []));
  }

  const result = await new ValuationService(database, book).materialize({
    fromDate: bounds.fromDate,
    toDate: bounds.toDate,
    targetCurrencies,
  });
  return {
    entryValuations: result.entryValuations,
    balanceValuations: result.balanceValuations,
    costValuations: result.costValuations,
    fxSourceValuations: result.fxSourceValuations,
    missingRateCount: result.missingRates.length,
    unavailableSources,
  };
}

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hmacIdentifier } from "@/domain/privacy";
import { openEncryptedDatabase, type EncryptedDatabase } from "@/server/db/database";
import { applyMigrations } from "@/server/db/migrations";
import { PrivatFopJournalAdapter } from "@/server/import/privat-fop";
import { PrivatPersonalStatementAdapter } from "@/server/import/privat-personal";
import { MonobankStatementAdapter } from "@/server/import/monobank";
import { SecurePreviewStore } from "@/server/import/preview-store";
import { ImportRepository } from "@/server/import/repository";
import { ImportService } from "@/server/import/service";
import type { ImportAdapter } from "@/server/import/adapter";
import { createStatementImportAdapter } from "@/server/import/adapter";
import { legacyWorkbookFromRows, workbookFromRows } from "../helpers/workbook";

const PERSONAL_HEADERS = [
  "Дата", "Категорія", "Картка", "Опис операції", "Сума в валюті картки", "Валюта картки",
  "Сума в валюті транзакції", "Валюта транзакції", "Залишок на кінець періоду", "Валюта залишку",
];
const FOP_HEADERS = [
  "№", "Дата проведення", "Сума", "Валюта", "Рахунок відправника", "Рахунок отримувача",
  "Призначення платежу", "Стан платежу",
];
const KEY = Buffer.alloc(32, 31);

function personalStatement(): Buffer {
  return workbookFromRows([
    ["SYNTHETIC PRIVAT EXPORT"],
    PERSONAL_HEADERS,
    ["01.01.2099 10:00:00", "Synthetic", "SYNTH-CARD-0001", "SYNTHETIC PURCHASE", "-10.00", "UAH", "-10.00", "UAH", "90.00", "UAH"],
  ]);
}

function personalStatementWithBalanceGap(): Buffer {
  return workbookFromRows([
    ["SYNTHETIC PRIVAT EXPORT"],
    PERSONAL_HEADERS,
    ["01.01.2099 10:00:00", "Synthetic", "SYNTH-CARD-0001", "SYNTHETIC CREDIT", "10.00", "UAH", "10.00", "UAH", "10.00", "UAH"],
    ["02.01.2099 10:00:00", "Synthetic", "SYNTH-CARD-0001", "SYNTHETIC DEBIT", "-1.00", "UAH", "-1.00", "UAH", "8.00", "UAH"],
  ]);
}

function fopJournal(): Buffer {
  return workbookFromRows([
    FOP_HEADERS,
    ["SYNTHETIC-1", "01.01.2099 10:00:00", "10.00", "UAH", "SYNTH-FOP-0001", "SYNTH-EXTERNAL-0002", "SYNTHETIC PAYMENT", "Сплачено"],
  ]);
}

function monobankStatement(): Buffer {
  return legacyWorkbookFromRows([
    ["Клієнт: SYNTHETIC PERSON"],
    ["Інформація по картці: SYNTHETIC-MONO-CARD-0003"],
    ["Рахунок: SYNTHETIC-MONO-IBAN-0004"],
    [
      "Дата і час операції", "Деталі операції", "MCC", "Сума в валюті картки (UAH)",
      "Сума в валюті операції", "Валюта", "Курс", "Сума комісій (UAH)",
      "Сума кешбеку (UAH)", "Залишок після операції",
    ],
    ["01.01.2099 10:00:00", "SYNTHETIC MONO PURCHASE", 5411, -10, -10, "UAH", 1, 0, 0, 90],
  ]);
}

function rejectedMonobankStatement(): Buffer {
  return legacyWorkbookFromRows([
    ["Клієнт: SYNTHETIC PERSON"],
    ["Інформація по картці: SYNTHETIC-MONO-CARD-0003"],
    ["Рахунок: SYNTHETIC-MONO-IBAN-0004"],
    [
      "Дата і час операції", "Деталі операції", "MCC", "Сума в валюті картки (UAH)",
      "Сума в валюті операції", "Валюта", "Курс", "Сума комісій (UAH)",
      "Сума кешбеку (UAH)", "Залишок після операції",
    ],
    ["01.01.2099 10:00:00", "SYNTHETIC INVALID ROW", 5411, "-", -10, "UAH", 1, 0, 0, 90],
  ]);
}

describe("import service", () => {
  let directory: string;
  let database: EncryptedDatabase;
  let service: ImportService;
  let previewStore: SecurePreviewStore;
  const backupAfterImport = vi.fn(async () => ({ integrity: "ok" as const }));

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "moneywave-import-service-"));
    database = await openEncryptedDatabase(join(directory, "moneywave.db"), Buffer.alloc(32, 32));
    await applyMigrations(database);
    previewStore = new SecurePreviewStore(join(directory, "previews"));
    const repository = new ImportRepository(database);
    const personal = new PrivatPersonalStatementAdapter({ identifierKey: KEY });
    const fop = new PrivatFopJournalAdapter({ identifierKey: KEY });
    const mono = new MonobankStatementAdapter({ identifierKey: KEY });
    service = new ImportService({
      adapters: [
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
      repository,
      previewStore,
      backupAfterImport,
    });
  });

  afterEach(async () => {
    await database.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("previews with masked identifiers, commits atomically, and runs the post-import backup", async () => {
    const preview = await service.preview(personalStatement());
    expect(preview).toMatchObject({ parserKind: "privat_personal", rowCount: 1, duplicate: false });
    expect(preview.identifiers).toEqual([
      expect.objectContaining({ display: "•••• 0001", identifierKind: "instrument", currencies: ["UAH"] }),
    ]);
    expect(JSON.stringify(preview)).not.toContain("SYNTH-CARD");

    const identifierHash = hmacIdentifier("SYNTH-CARD-0001", KEY);
    const originalRead = previewStore.read.bind(previewStore);
    let transientBytes: Buffer | undefined;
    vi.spyOn(previewStore, "read").mockImplementation(async (id) => {
      transientBytes = await originalRead(id);
      return transientBytes;
    });
    const result = await service.commit({
      previewId: preview.previewId,
      mappingComplete: true,
      registrations: [{
        accountId: "personal-uah",
        displayName: "Personal UAH",
        ownerScope: "PERSONAL",
        accountType: "card",
        currency: "UAH",
        identifierHash,
        identifierKind: "instrument",
        instrumentId: "card-synthetic",
        maskedDisplay: "•••• 0001",
      }],
    });

    expect(result).toMatchObject({ rowCount: 1, postedCount: 1, backupStatus: "verified" });
    expect(backupAfterImport).toHaveBeenCalledTimes(1);
    expect(transientBytes?.every((byte) => byte === 0)).toBe(true);
    await expect(previewStore.read(preview.previewId)).rejects.toThrow("IMPORT_PREVIEW_NOT_FOUND");
    expect(await database.get<{ count: number }>("SELECT count(*) AS count FROM import_artifacts")).toEqual({ count: 1 });
  });

  it("rejects duplicate artifacts before creating another preview", async () => {
    const first = await service.preview(personalStatement());
    const identifierHash = hmacIdentifier("SYNTH-CARD-0001", KEY);
    await service.commit({
      previewId: first.previewId,
      mappingComplete: true,
      registrations: [{ ...first.identifiers[0]!, identifierHash, accountId: "personal-uah", displayName: "Personal UAH", ownerScope: "PERSONAL", accountType: "card", currency: "UAH", instrumentId: "card-synthetic", maskedDisplay: "•••• 0001" }],
    });
    await expect(service.preview(personalStatement())).rejects.toThrow("ARTIFACT_ALREADY_IMPORTED");
  });

  it("requires explicit mapping completion and always cleans a failed preview", async () => {
    const preview = await service.preview(personalStatement());
    await expect(service.commit({ previewId: preview.previewId, mappingComplete: false, registrations: [] }))
      .rejects.toThrow("OWNERSHIP_MAPPING_INCOMPLETE");
    await expect(previewStore.read(preview.previewId)).rejects.toThrow("IMPORT_PREVIEW_NOT_FOUND");
    expect(backupAfterImport).not.toHaveBeenCalled();
    expect(await database.get<{ count: number }>("SELECT count(*) AS count FROM import_artifacts")).toEqual({ count: 0 });
  });

  it("rejects a forged masked identifier instead of trusting client mapping fields", async () => {
    const preview = await service.preview(personalStatement());
    const identifierHash = hmacIdentifier("SYNTH-CARD-0001", KEY);

    await expect(service.commit({
      previewId: preview.previewId,
      mappingComplete: true,
      registrations: [{
        accountId: "personal-uah",
        displayName: "Personal UAH",
        ownerScope: "PERSONAL",
        accountType: "card",
        currency: "UAH",
        identifierHash,
        identifierKind: "instrument",
        instrumentId: "card-synthetic",
        maskedDisplay: "•••• 9999",
      }],
    })).rejects.toThrow("OWNERSHIP_MAPPING_DISPLAY_CONFLICT");

    expect(await database.get<{ count: number }>("SELECT count(*) AS count FROM import_artifacts")).toEqual({ count: 0 });
  });

  it("requires at least one explicitly owned account for a FOP journal", async () => {
    const preview = await service.preview(fopJournal());

    await expect(service.commit({ previewId: preview.previewId, mappingComplete: true, registrations: [] }))
      .rejects.toThrow("OWNERSHIP_MAPPING_INCOMPLETE");
    expect(await database.get<{ count: number }>("SELECT count(*) AS count FROM import_artifacts")).toEqual({ count: 0 });
  });

  it("persists batch-level reconciliation warnings instead of losing them after preview", async () => {
    const preview = await service.preview(personalStatementWithBalanceGap());
    const identifierHash = hmacIdentifier("SYNTH-CARD-0001", KEY);
    const result = await service.commit({
      previewId: preview.previewId,
      mappingComplete: true,
      registrations: [{
        accountId: "personal-uah",
        displayName: "Personal UAH",
        ownerScope: "PERSONAL",
        accountType: "card",
        currency: "UAH",
        identifierHash,
        identifierKind: "instrument",
        instrumentId: "card-synthetic",
        maskedDisplay: "•••• 0001",
      }],
    });

    expect(result.issueCodes).toEqual(["BALANCE_DISCONTINUITY"]);
    expect(await database.get<{ issues: string }>(
      "SELECT reconciliation_issues_json AS issues FROM import_batches",
    )).toEqual({ issues: '["BALANCE_DISCONTINUITY"]' });
  });

  it("dispatches a third provider adapter without a provider-specific service branch", async () => {
    const thirdProviderBytes = Buffer.from("SYNTHETIC-THIRD-PROVIDER", "utf8");
    const identifierHash = "c".repeat(64);
    const thirdAdapter: ImportAdapter = {
      providerCode: "syntheticbank",
      providerDisplayName: "Synthetic Bank",
      parserKind: "monobank_personal",
      parserVersion: "syntheticbank@1",
      ownershipPolicy: "all_discovered",
      probe: (bytes) => ({ matched: bytes.equals(thirdProviderBytes), kind: "monobank_personal" }),
      inspect: () => ({
        rowCount: 1,
        identifiers: [{ identifierHash, display: "•••• 0002", currencies: ["UAH"], identifierKind: "instrument" }],
      }),
      normalize: () => ({
        kind: "monobank_personal",
        rows: [{
          sourceRowNumber: 1,
          sourceRecordId: "source-third-provider",
          dedupeFingerprint: "d".repeat(64),
          state: "posted",
          direction: "debit",
          sourceMetadata: { status: "SYNTHETIC" },
          observations: [{
            id: "observation-third-provider",
            sourceRecordId: "source-third-provider",
            provider: "syntheticbank",
            accountId: "syntheticbank-uah",
            instrumentId: "syntheticbank-card",
            ownerScope: "PERSONAL",
            direction: "debit",
            amountMinor: -1_000n,
            currency: "UAH",
            occurredAt: "2099-01-01T10:00:00",
            ownIdentifierHash: identifierHash,
            description: "SYNTHETIC PURCHASE",
          }],
        }],
      }),
      reconcile: (normalized) => ({
        rowCount: normalized.rows.length,
        coveredRowCount: normalized.rows.length,
        silentlySkippedRowCount: 0,
        stateCounts: { posted: 1, non_posted: 0, unresolved: 0, rejected: 0 },
        issues: [],
      }),
    };
    const thirdService = new ImportService({
      adapters: [thirdAdapter],
      repository: new ImportRepository(database),
      previewStore,
      backupAfterImport,
    });

    const preview = await thirdService.preview(thirdProviderBytes);
    expect(preview).toMatchObject({ parserKind: "monobank_personal", providerCode: "syntheticbank", rowCount: 1 });
    await thirdService.commit({
      previewId: preview.previewId,
      mappingComplete: true,
      registrations: [{
        accountId: "syntheticbank-uah",
        displayName: "Synthetic Bank UAH",
        ownerScope: "PERSONAL",
        accountType: "card",
        currency: "UAH",
        identifierHash,
        identifierKind: "instrument",
        instrumentId: "syntheticbank-card",
        maskedDisplay: "•••• 0002",
      }],
    });

    expect(await database.get<{ provider: string }>(`
      SELECT provider.code AS provider
      FROM accounts account
      JOIN providers provider ON provider.id = account.provider_id
      WHERE account.id = 'syntheticbank-uah'
    `)).toEqual({ provider: "syntheticbank" });
  });

  it("previews and commits a Monobank account together with its card instrument", async () => {
    const bytes = monobankStatement();
    const preview = await service.preview(bytes);
    expect(preview).toMatchObject({ parserKind: "monobank_personal", providerCode: "monobank", rowCount: 1 });
    expect(preview.identifiers).toEqual([expect.objectContaining({
      identifierKind: "account",
      display: "•••• 0004",
      instrumentDisplay: "•••• 0003",
      currencies: ["UAH"],
    })]);
    const identifier = preview.identifiers[0]!;

    await service.commit({
      previewId: preview.previewId,
      mappingComplete: true,
      registrations: [{
        accountId: "mono-uah",
        displayName: "Mono UAH",
        ownerScope: "PERSONAL",
        accountType: "card",
        currency: "UAH",
        identifierHash: identifier.identifierHash,
        identifierKind: "account",
        instrumentId: "mono-card",
        instrumentIdentifierHash: identifier.instrumentIdentifierHash,
        instrumentMaskedDisplay: identifier.instrumentDisplay,
        maskedDisplay: identifier.display,
      }],
    });

    expect(await database.get<{ provider: string; instrumentCount: number }>(`
      SELECT provider.code AS provider,
             (SELECT count(*) FROM account_instruments instrument WHERE instrument.account_id = account.id) AS instrumentCount
      FROM accounts account
      JOIN providers provider ON provider.id = account.provider_id
      WHERE account.id = 'mono-uah'
    `)).toEqual({ provider: "monobank", instrumentCount: 1 });
  });

  it("does not commit a statement adapter import when every row was rejected", async () => {
    const preview = await service.preview(rejectedMonobankStatement());
    const identifier = preview.identifiers[0]!;

    await expect(service.commit({
      previewId: preview.previewId,
      mappingComplete: true,
      registrations: [{
        accountId: "mono-uah",
        displayName: "Mono UAH",
        ownerScope: "PERSONAL",
        accountType: "card",
        currency: "UAH",
        identifierHash: identifier.identifierHash,
        identifierKind: "account",
        instrumentId: "mono-card",
        instrumentIdentifierHash: identifier.instrumentIdentifierHash,
        instrumentMaskedDisplay: identifier.instrumentDisplay,
        maskedDisplay: identifier.display,
      }],
    })).rejects.toThrow("IMPORT_POSTED_ROWS_EMPTY");

    expect(await database.get<{ count: number }>("SELECT count(*) AS count FROM import_artifacts"))
      .toEqual({ count: 0 });
  });
});

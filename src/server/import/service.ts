import { createHash } from "node:crypto";

import type { ImportAdapter } from "./adapter";
import type { SecurePreviewStore } from "./preview-store";
import type { ImportAccountRegistration, ImportRepository } from "./repository";
import type { NormalizationResult, OwnershipTarget } from "./types";

export interface ImportPreviewIdentifier {
  identifierHash: string;
  display: string;
  currencies: string[];
  identifierKind: "account" | "instrument";
  instrumentIdentifierHash?: string;
  instrumentDisplay?: string;
}

export interface ImportPreview {
  previewId: string;
  parserKind: NormalizationResult["kind"];
  providerCode: string;
  providerDisplayName: string;
  rowCount: number;
  duplicate: false;
  identifiers: ImportPreviewIdentifier[];
  expiresAt: number;
}

type BackupAfterImport = (batchId: string) => Promise<{ integrity: "ok" }>;

export class ImportService {
  readonly #adapters: readonly ImportAdapter[];
  readonly #repository: ImportRepository;
  readonly #previewStore: SecurePreviewStore;
  readonly #backupAfterImport: BackupAfterImport;

  constructor(input: {
    adapters: readonly ImportAdapter[];
    repository: ImportRepository;
    previewStore: SecurePreviewStore;
    backupAfterImport: BackupAfterImport;
  }) {
    if (input.adapters.length === 0) throw new Error("IMPORT_ADAPTERS_EMPTY");
    const parserKinds = new Set(input.adapters.map(({ parserKind }) => parserKind));
    if (parserKinds.size !== input.adapters.length) throw new Error("IMPORT_ADAPTER_KIND_DUPLICATE");
    this.#adapters = input.adapters;
    this.#repository = input.repository;
    this.#previewStore = input.previewStore;
    this.#backupAfterImport = input.backupAfterImport;
  }

  async preview(bytes: Buffer): Promise<ImportPreview> {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (await this.#repository.hasArtifact(sha256)) throw new Error("ARTIFACT_ALREADY_IMPORTED");

    const adapter = this.#adapters.find((candidate) => candidate.probe(bytes).matched);
    if (!adapter) throw new Error("IMPORT_FORMAT_UNSUPPORTED");
    const parserKind = adapter.parserKind;
    const { rowCount, identifiers } = adapter.inspect(bytes);
    if (rowCount === 0) throw new Error("IMPORT_ROWS_EMPTY");
    const stored = await this.#previewStore.put(bytes, { parserKind });
    if (stored.sha256 !== sha256) {
      await this.#previewStore.delete(stored.id);
      throw new Error("IMPORT_PREVIEW_HASH_MISMATCH");
    }
    return {
      previewId: stored.id,
      parserKind,
      providerCode: adapter.providerCode,
      providerDisplayName: adapter.providerDisplayName,
      rowCount,
      duplicate: false,
      identifiers,
      expiresAt: stored.expiresAt,
    };
  }

  async commit(input: {
    previewId: string;
    mappingComplete: boolean;
    registrations: readonly ImportAccountRegistration[];
  }): Promise<{
    batchId: string;
    rowCount: number;
    postedCount: number;
    nonPostedCount: number;
    unresolvedCount: number;
    rejectedCount: number;
    canonicalEntriesCreated: number;
    evidenceMerged: number;
    conflictsCreated: number;
    backupStatus: "verified" | "failed";
    issueCodes: string[];
  }> {
    let bytes: Buffer | undefined;
    try {
      if (!input.mappingComplete) throw new Error("OWNERSHIP_MAPPING_INCOMPLETE");
      const metadata = this.#previewStore.get(input.previewId);
      if (!metadata) throw new Error("IMPORT_PREVIEW_NOT_FOUND");
      const adapter = this.#adapters.find(({ parserKind }) => parserKind === metadata.parserKind);
      if (!adapter) throw new Error("IMPORT_PREVIEW_KIND_INVALID");
      bytes = await this.#previewStore.read(input.previewId);
      const discovered = adapter.inspect(bytes);
      this.#validateRegistrations(adapter, discovered.identifiers, input.registrations);
      const ownership = new Map<string, OwnershipTarget>(input.registrations.map((registration) => [
        registration.identifierHash,
        {
          accountId: registration.accountId,
          instrumentId: registration.instrumentId,
          instrumentIdentifierHash: registration.instrumentIdentifierHash
            ?? (registration.identifierKind === "instrument" ? registration.identifierHash : undefined),
          ownerScope: registration.ownerScope,
        },
      ]));
      const normalization = adapter.normalize(bytes, { ownership, mappingComplete: true });
      const reconciliation = adapter.reconcile(normalization);
      if (
        reconciliation.rowCount !== discovered.rowCount
        || reconciliation.coveredRowCount !== discovered.rowCount
        || reconciliation.silentlySkippedRowCount !== 0
      ) {
        throw new Error("IMPORT_ROW_COVERAGE_FAILED");
      }
      if (
        adapter.minimumPostedRows !== undefined
        && reconciliation.stateCounts.posted < adapter.minimumPostedRows
      ) {
        throw new Error("IMPORT_POSTED_ROWS_EMPTY");
      }
      const rowReasonCodes = new Set(normalization.rows.flatMap(({ reasonCode }) => reasonCode ? [reasonCode] : []));
      const batchIssueCodes = reconciliation.issues.filter((code) => !rowReasonCodes.has(code));
      const committed = await this.#repository.commitImport({
        artifact: {
          bytes,
          sha256: metadata.sha256,
          parserKind: metadata.parserKind,
          parserVersion: adapter.parserVersion,
        },
        normalization,
        registrations: input.registrations,
        provider: { code: adapter.providerCode, displayName: adapter.providerDisplayName },
        reconciliationIssueCodes: batchIssueCodes,
      });
      let backupStatus: "verified" | "failed" = "verified";
      try {
        const backup = await this.#backupAfterImport(committed.batchId);
        if (backup.integrity !== "ok") backupStatus = "failed";
      } catch {
        backupStatus = "failed";
      }
      return {
        batchId: committed.batchId,
        rowCount: committed.rowCount,
        postedCount: committed.postedCount,
        nonPostedCount: committed.nonPostedCount,
        unresolvedCount: committed.unresolvedCount,
        rejectedCount: committed.rejectedCount,
        canonicalEntriesCreated: committed.canonicalEntriesCreated,
        evidenceMerged: committed.evidenceMerged,
        conflictsCreated: committed.conflictsCreated,
        backupStatus,
        issueCodes: reconciliation.issues,
      };
    } finally {
      bytes?.fill(0);
      await this.#previewStore.delete(input.previewId);
    }
  }

  async rollback(previewId: string): Promise<void> {
    await this.#previewStore.delete(previewId);
  }

  #validateRegistrations(
    adapter: ImportAdapter,
    discovered: readonly ImportPreviewIdentifier[],
    registrations: readonly ImportAccountRegistration[],
  ): void {
    if (adapter.ownershipPolicy === "at_least_one" && registrations.length === 0) {
      throw new Error("OWNERSHIP_MAPPING_INCOMPLETE");
    }
    const discoveredByHash = new Map(discovered.map((item) => [item.identifierHash, item]));
    const registered = new Set<string>();
    for (const registration of registrations) {
      if (registered.has(registration.identifierHash)) throw new Error("OWNERSHIP_MAPPING_DUPLICATE_IDENTIFIER");
      registered.add(registration.identifierHash);
      const candidate = discoveredByHash.get(registration.identifierHash);
      if (!candidate || candidate.identifierKind !== registration.identifierKind) throw new Error("OWNERSHIP_MAPPING_UNKNOWN_IDENTIFIER");
      if (!candidate.currencies.includes(registration.currency)) throw new Error("OWNERSHIP_MAPPING_CURRENCY_CONFLICT");
      if (candidate.display !== registration.maskedDisplay) throw new Error("OWNERSHIP_MAPPING_DISPLAY_CONFLICT");
      if ((candidate.instrumentIdentifierHash ?? null) !== (registration.instrumentIdentifierHash ?? null)) {
        throw new Error("OWNERSHIP_MAPPING_INSTRUMENT_CONFLICT");
      }
      if ((candidate.instrumentDisplay ?? null) !== (registration.instrumentMaskedDisplay ?? null)) {
        throw new Error("OWNERSHIP_MAPPING_INSTRUMENT_CONFLICT");
      }
    }
    if (adapter.ownershipPolicy === "all_discovered") {
      if (discovered.some(({ identifierHash }) => !registered.has(identifierHash))) throw new Error("OWNERSHIP_MAPPING_INCOMPLETE");
    }
  }
}

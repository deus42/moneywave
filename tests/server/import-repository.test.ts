import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { NormalizationResult, NormalizedSourceRow } from "@/server/import/types";
import { openEncryptedDatabase, type EncryptedDatabase } from "@/server/db/database";
import { applyMigrations } from "@/server/db/migrations";
import { ImportRepository, type ImportAccountRegistration } from "@/server/import/repository";

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const registration: ImportAccountRegistration = {
  accountId: "account-synthetic",
  displayName: "Synthetic account",
  ownerScope: "PERSONAL",
  accountType: "card",
  currency: "UAH",
  identifierHash: "a".repeat(64),
  identifierKind: "instrument",
  instrumentId: "instrument-synthetic",
  maskedDisplay: "•••• 0001",
};
const PRIVAT_PROVIDER = { code: "privatbank", displayName: "PrivatBank" } as const;

function postedRow(id: string, fingerprint: string, amountMinor = -1_000n): NormalizedSourceRow {
  return {
    sourceRowNumber: Number(id.replace(/\D/g, "")) || 1,
    sourceRecordId: `source-${id}`,
    dedupeFingerprint: fingerprint,
    state: "posted",
    direction: amountMinor < 0n ? "debit" : "credit",
    sourceMetadata: { status: "SYNTHETIC" },
    observations: [{
      id: `observation-${id}`,
      sourceRecordId: `source-${id}`,
      provider: "privatbank",
      accountId: "account-synthetic",
      instrumentId: "instrument-synthetic",
      ownerScope: "PERSONAL",
      direction: amountMinor < 0n ? "debit" : "credit",
      amountMinor,
      currency: "UAH",
      occurredAt: "2099-01-01T10:00:00",
      ownIdentifierHash: "a".repeat(64),
      description: "SYNTHETIC DESCRIPTION",
    }],
  };
}

function withProviderReference(row: NormalizedSourceRow, providerReference: string): NormalizedSourceRow {
  return {
    ...row,
    observations: row.observations.map((observation) => ({ ...observation, providerReference })),
  };
}

function normalization(rows: NormalizedSourceRow[]): NormalizationResult {
  return { kind: "privat_personal", rows };
}

function nonPostedRow(id: string, fingerprint: string): NormalizedSourceRow {
  return {
    sourceRowNumber: Number(id.replace(/\D/g, "")) || 1,
    sourceRecordId: `source-${id}`,
    dedupeFingerprint: fingerprint,
    state: "non_posted",
    reasonCode: "PAYMENT_SAVED",
    sourceMetadata: { status: "SYNTHETIC" },
    observations: [],
  };
}

function undatedRow(id: string, fingerprint: string): NormalizedSourceRow {
  return {
    sourceRowNumber: Number(id.replace(/\D/g, "")) || 1,
    sourceRecordId: `source-${id}`,
    dedupeFingerprint: fingerprint,
    state: "unresolved",
    reasonCode: "CONDUCTED_DATE_MISSING",
    direction: "debit",
    sourceMetadata: { status: "SYNTHETIC" },
    observations: [],
    undatedObservations: [{
      id: `undated-${id}`,
      sourceRecordId: `source-${id}`,
      provider: "privatbank",
      accountId: "account-synthetic",
      instrumentId: "instrument-synthetic",
      ownerScope: "PERSONAL",
      direction: "debit",
      amountMinor: -1_000n,
      currency: "UAH",
      ownIdentifierHash: "a".repeat(64),
      counterpartyIdentifierHash: "b".repeat(64),
      description: "SYNTHETIC UNDATED",
    }],
  };
}

describe("atomic import repository", () => {
  let directory: string;
  let database: EncryptedDatabase;
  let repository: ImportRepository;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "moneywave-import-repository-"));
    database = await openEncryptedDatabase(join(directory, "moneywave.db"), Buffer.alloc(32, 21));
    await applyMigrations(database);
    repository = new ImportRepository(database);
  });

  afterEach(async () => {
    await database.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });

  it("stores the immutable raw artifact and rejects the same SHA-256 without partial writes", async () => {
    const bytes = Buffer.from("SYNTHETIC-ARTIFACT-ONE", "utf8");
    const artifact = { bytes, sha256: sha(bytes.toString("utf8")), parserKind: "privat_personal" as const, parserVersion: "1" };
    const result = await repository.commitImport({ artifact, normalization: normalization([postedRow("1", "f".repeat(64))]), registrations: [registration], provider: PRIVAT_PROVIDER });
    expect(result).toMatchObject({ artifactStored: true, canonicalEntriesCreated: 1, evidenceMerged: 0 });
    const stored = await database.get<{ bytes: Buffer }>("SELECT encrypted_bytes AS bytes FROM import_artifacts WHERE sha256 = ?", [artifact.sha256]);
    expect(stored?.bytes).toEqual(bytes);

    await expect(repository.commitImport({ artifact, normalization: normalization([postedRow("1", "f".repeat(64))]), registrations: [registration], provider: PRIVAT_PROVIDER }))
      .rejects.toThrow("ARTIFACT_ALREADY_IMPORTED");
    expect(await database.get<{ count: number }>("SELECT count(*) AS count FROM import_artifacts")).toEqual({ count: 1 });
    expect(await database.get<{ count: number }>("SELECT count(*) AS count FROM import_batches")).toEqual({ count: 1 });
  });

  it("persists provider fee composition and provider metadata without creating another debit", async () => {
    const bytes = Buffer.from("SYNTHETIC-MONOBANK-FEE", "utf8");
    const row = postedRow("91", "a".repeat(64), -1_050n);
    row.sourceMetadata = {
      mcc: "5411",
      providerRate: "42",
      explicitFeeMinor: "50",
      explicitFeeCurrency: "UAH",
      cashbackMinor: "10",
      cashbackCurrency: "UAH",
    };
    row.observations[0]!.provider = "monobank";
    row.observations[0]!.explicitFeeMinor = 50n;
    row.observations[0]!.explicitFeeCurrency = "UAH";

    await repository.commitImport({
      artifact: { bytes, sha256: sha(bytes.toString("utf8")), parserKind: "monobank_personal", parserVersion: "1" },
      normalization: { kind: "monobank_personal", rows: [row] },
      registrations: [registration],
      provider: { code: "monobank", displayName: "monobank" },
    });

    expect(await database.get<{ entries: number }>("SELECT count(*) AS entries FROM ledger_entries")).toEqual({ entries: 1 });
    expect(await database.get<{ amount: string; currency: string; included: number }>(`
      SELECT CAST(pfe.amount_minor AS TEXT) AS amount, pfe.currency, pfe.included_in_settlement AS included
      FROM provider_fee_evidence pfe
      JOIN transaction_evidence te ON te.id = pfe.transaction_evidence_id
    `)).toEqual({ amount: "50", currency: "UAH", included: 1 });
    expect(JSON.parse((await database.get<{ metadata: string }>(
      "SELECT source_metadata_json AS metadata FROM source_records",
    ))?.metadata ?? "{}")).toEqual(row.sourceMetadata);
  });

  it("rolls back the entire import when provider fee evidence is invalid", async () => {
    const bytes = Buffer.from("SYNTHETIC-MONOBANK-INVALID-FEE", "utf8");
    const row = postedRow("92", "b".repeat(64), -1_050n);
    row.observations[0]!.provider = "monobank";
    row.observations[0]!.explicitFeeMinor = -50n;
    row.observations[0]!.explicitFeeCurrency = "UAH";

    await expect(repository.commitImport({
      artifact: { bytes, sha256: sha(bytes.toString("utf8")), parserKind: "monobank_personal", parserVersion: "1" },
      normalization: { kind: "monobank_personal", rows: [row] },
      registrations: [registration],
      provider: { code: "monobank", displayName: "monobank" },
    })).rejects.toThrow("PROVIDER_FEE_INVALID");

    expect(await database.get<{ count: number }>("SELECT count(*) AS count FROM import_artifacts")).toEqual({ count: 0 });
    expect(await database.get<{ count: number }>("SELECT count(*) AS count FROM ledger_entries")).toEqual({ count: 0 });
  });

  it("uses account-scoped multiset overlap matching while preserving legitimate identical rows", async () => {
    const fingerprint = "b".repeat(64);
    const firstBytes = Buffer.from("SYNTHETIC-OVERLAP-FIRST", "utf8");
    const first = await repository.commitImport({
      artifact: { bytes: firstBytes, sha256: sha(firstBytes.toString("utf8")), parserKind: "privat_personal", parserVersion: "1" },
      normalization: normalization([postedRow("1", fingerprint), postedRow("2", fingerprint)]),
      registrations: [registration],
      provider: PRIVAT_PROVIDER,
    });
    expect(first).toMatchObject({ canonicalEntriesCreated: 2, evidenceMerged: 0 });

    const overlapBytes = Buffer.from("SYNTHETIC-OVERLAP-SECOND", "utf8");
    const overlap = await repository.commitImport({
      artifact: { bytes: overlapBytes, sha256: sha(overlapBytes.toString("utf8")), parserKind: "privat_personal", parserVersion: "1" },
      normalization: normalization([postedRow("3", fingerprint)]),
      registrations: [registration],
      provider: PRIVAT_PROVIDER,
    });
    expect(overlap).toMatchObject({ canonicalEntriesCreated: 0, evidenceMerged: 1 });
    expect(await database.get<{ count: number }>("SELECT count(*) AS count FROM ledger_entries")).toEqual({ count: 2 });
    expect(await database.get<{ count: number }>("SELECT count(*) AS count FROM transaction_evidence")).toEqual({ count: 3 });
  });

  it("reuses the canonical instrument id when a later browser mapping supplies a fresh local id", async () => {
    const firstBytes = Buffer.from("SYNTHETIC-INSTRUMENT-FIRST", "utf8");
    await repository.commitImport({
      artifact: { bytes: firstBytes, sha256: sha(firstBytes.toString("utf8")), parserKind: "privat_personal", parserVersion: "1" },
      normalization: normalization([postedRow("1", "6".repeat(64))]),
      registrations: [registration],
      provider: PRIVAT_PROVIDER,
    });
    const secondBytes = Buffer.from("SYNTHETIC-INSTRUMENT-SECOND", "utf8");
    const secondRow = postedRow("2", "7".repeat(64));
    secondRow.observations[0]!.instrumentId = "instrument-browser-fresh";

    await expect(repository.commitImport({
      artifact: { bytes: secondBytes, sha256: sha(secondBytes.toString("utf8")), parserKind: "privat_personal", parserVersion: "1" },
      normalization: normalization([secondRow]),
      registrations: [{ ...registration, instrumentId: "instrument-browser-fresh" }],
      provider: PRIVAT_PROVIDER,
    })).resolves.toMatchObject({ evidenceMerged: 1 });
    expect(await database.all<{ instrumentId: string }>(
      "SELECT DISTINCT instrument_id AS instrumentId FROM transaction_evidence ORDER BY instrument_id",
    )).toEqual([{ instrumentId: "instrument-synthetic" }]);
  });

  it("binds a newly observed account identifier to an existing instrument-backed account", async () => {
    const personalBytes = Buffer.from("SYNTHETIC-ACCOUNT-BIND-FIRST", "utf8");
    await repository.commitImport({
      artifact: { bytes: personalBytes, sha256: sha(personalBytes.toString("utf8")), parserKind: "privat_personal", parserVersion: "1" },
      normalization: normalization([postedRow("1", "8".repeat(64))]),
      registrations: [registration],
      provider: PRIVAT_PROVIDER,
    });
    const accountHash = "b".repeat(64);
    const fopBytes = Buffer.from("SYNTHETIC-ACCOUNT-BIND-SECOND", "utf8");
    await repository.commitImport({
      artifact: { bytes: fopBytes, sha256: sha(fopBytes.toString("utf8")), parserKind: "privat_fop_journal", parserVersion: "1" },
      normalization: { kind: "privat_fop_journal", rows: [] },
      registrations: [{ ...registration, identifierKind: "account", identifierHash: accountHash, instrumentId: undefined }],
      provider: PRIVAT_PROVIDER,
    });

    expect(await database.get<{ identifierHash: string }>(
      "SELECT identifier_hmac AS identifierHash FROM accounts WHERE id = ?",
      [registration.accountId],
    )).toEqual({ identifierHash: accountHash });
  });

  it("merges journal and card evidence for the same exact account observation without duplicating the canonical entry", async () => {
    const firstBytes = Buffer.from("SYNTHETIC-JOURNAL-EVIDENCE", "utf8");
    await repository.commitImport({
      artifact: { bytes: firstBytes, sha256: sha(firstBytes.toString("utf8")), parserKind: "privat_fop_journal", parserVersion: "1" },
      normalization: { kind: "privat_fop_journal", rows: [postedRow("1", "d".repeat(64))] },
      registrations: [registration],
      provider: PRIVAT_PROVIDER,
    });

    const secondBytes = Buffer.from("SYNTHETIC-CARD-EVIDENCE", "utf8");
    const result = await repository.commitImport({
      artifact: { bytes: secondBytes, sha256: sha(secondBytes.toString("utf8")), parserKind: "privat_personal", parserVersion: "1" },
      normalization: { kind: "privat_personal", rows: [postedRow("2", "e".repeat(64))] },
      registrations: [registration],
      provider: PRIVAT_PROVIDER,
    });

    expect(result).toMatchObject({ canonicalEntriesCreated: 0, evidenceMerged: 1 });
    expect(await database.get<{ count: number }>("SELECT count(*) AS count FROM ledger_entries")).toEqual({ count: 1 });
    expect(await database.get<{ count: number }>("SELECT count(*) AS count FROM transaction_evidence")).toEqual({ count: 2 });
  });

  it("rolls back artifact, batch, and rows when any observation cannot be persisted", async () => {
    const bytes = Buffer.from("SYNTHETIC-ROLLBACK", "utf8");
    await expect(repository.commitImport({
      artifact: { bytes, sha256: sha(bytes.toString("utf8")), parserKind: "privat_personal", parserVersion: "1" },
      normalization: normalization([postedRow("1", "c".repeat(64))]),
      registrations: [],
      provider: PRIVAT_PROVIDER,
    })).rejects.toThrow();
    expect(await database.get<{ count: number }>("SELECT count(*) AS count FROM import_artifacts")).toEqual({ count: 0 });
    expect(await database.get<{ count: number }>("SELECT count(*) AS count FROM source_records")).toEqual({ count: 0 });
    expect(await database.get<{ count: number }>("SELECT count(*) AS count FROM ledger_entries")).toEqual({ count: 0 });
  });

  it("persists statement balances as evidence without treating them as inferred account balances", async () => {
    const bytes = Buffer.from("SYNTHETIC-BALANCE-EVIDENCE", "utf8");
    const row = postedRow("1", "9".repeat(64));
    row.observations[0]!.resultingBalanceMinor = 9_000n;
    row.observations[0]!.resultingBalanceCurrency = "UAH";

    await repository.commitImport({
      artifact: { bytes, sha256: sha(bytes.toString("utf8")), parserKind: "privat_personal", parserVersion: "1" },
      normalization: normalization([row]),
      registrations: [registration],
      provider: PRIVAT_PROVIDER,
    });

    expect(await database.get<{ balance: string; currency: string; evidenceKind: string }>(
      "SELECT CAST(balance_minor AS TEXT) AS balance, currency, evidence_kind AS evidenceKind FROM balance_snapshots",
    )).toEqual({ balance: "9000", currency: "UAH", evidenceKind: "statement" });
    expect(await database.get<{ status: string }>(
      "SELECT balance_evidence_status AS status FROM accounts WHERE id = ?",
      [registration.accountId],
    )).toEqual({ status: "statement" });
  });

  it("persists a complete status partition including non-posted evidence", async () => {
    const bytes = Buffer.from("SYNTHETIC-STATUS-PARTITION", "utf8");
    const result = await repository.commitImport({
      artifact: { bytes, sha256: sha(bytes.toString("utf8")), parserKind: "privat_fop_journal", parserVersion: "1" },
      normalization: { kind: "privat_fop_journal", rows: [postedRow("1", "1".repeat(64)), nonPostedRow("2", "2".repeat(64))] },
      registrations: [registration],
      provider: PRIVAT_PROVIDER,
    });

    expect(result).toMatchObject({ rowCount: 2, postedCount: 1, nonPostedCount: 1, unresolvedCount: 0, rejectedCount: 0 });
    expect(await database.get<{ total: number }>(
      "SELECT posted_count + non_posted_count + unresolved_count + rejected_count AS total FROM import_batches",
    )).toEqual({ total: 2 });
  });

  it("quarantines conflicting evidence for one provider reference without overwriting or duplicating the ledger entry", async () => {
    const firstBytes = Buffer.from("SYNTHETIC-REFERENCE-FIRST", "utf8");
    await repository.commitImport({
      artifact: { bytes: firstBytes, sha256: sha(firstBytes.toString("utf8")), parserKind: "privat_personal", parserVersion: "1" },
      normalization: normalization([withProviderReference(postedRow("1", "3".repeat(64), -1_000n), "SYNTHETIC-REFERENCE")]),
      registrations: [registration],
      provider: PRIVAT_PROVIDER,
    });

    const conflicting = withProviderReference(postedRow("2", "4".repeat(64), 2_000n), "SYNTHETIC-REFERENCE");
    conflicting.observations[0]!.currency = "USD";
    const secondBytes = Buffer.from("SYNTHETIC-REFERENCE-CONFLICT", "utf8");
    const result = await repository.commitImport({
      artifact: { bytes: secondBytes, sha256: sha(secondBytes.toString("utf8")), parserKind: "privat_personal", parserVersion: "1" },
      normalization: normalization([conflicting]),
      registrations: [registration],
      provider: PRIVAT_PROVIDER,
    });

    expect(result).toMatchObject({ canonicalEntriesCreated: 0, evidenceMerged: 1, conflictsCreated: 1 });
    expect(await database.get<{ count: number }>("SELECT count(*) AS count FROM ledger_entries")).toEqual({ count: 1 });
    expect(await database.get<{ amount: string; currency: string; direction: string }>(
      "SELECT CAST(amount_minor AS TEXT) AS amount, currency, direction FROM ledger_entries",
    )).toEqual({ amount: "-1000", currency: "UAH", direction: "debit" });
    expect(await database.get<{ count: number }>("SELECT count(*) AS count FROM transaction_evidence")).toEqual({ count: 2 });
    const conflict = await database.get<{ reasonCode: string; safeDetails: string }>(
      "SELECT reason_code AS reasonCode, safe_details_json AS safeDetails FROM reconciliation_conflicts",
    );
    expect(conflict?.reasonCode).toBe("SOURCE_OBSERVATION_CONFLICT");
    expect(JSON.parse(conflict?.safeDetails ?? "{}")).toEqual({ fields: ["amount", "currency", "direction"] });
    expect(conflict?.safeDetails).not.toContain("SYNTHETIC-REFERENCE");
  });

  it("persists undated observations as unresolved evidence without inventing a ledger date", async () => {
    const bytes = Buffer.from("SYNTHETIC-UNDATED-EVIDENCE", "utf8");
    await repository.commitImport({
      artifact: { bytes, sha256: sha(bytes.toString("utf8")), parserKind: "privat_fop_journal", parserVersion: "1" },
      normalization: { kind: "privat_fop_journal", rows: [undatedRow("1", "5".repeat(64))] },
      registrations: [registration],
      provider: PRIVAT_PROVIDER,
    });

    expect(await database.get<{ count: number }>("SELECT count(*) AS count FROM ledger_entries")).toEqual({ count: 0 });
    expect(await database.get<{ state: string; reasonCode: string }>(
      "SELECT sr.row_state AS state, sr.reason_code AS reasonCode FROM unresolved_observations uo JOIN source_records sr ON sr.id = uo.source_record_id",
    )).toEqual({ state: "unresolved", reasonCode: "CONDUCTED_DATE_MISSING" });
  });

  it("registers accounts against the provider declared by the import", async () => {
    const bytes = Buffer.from("SYNTHETIC-OTHER-PROVIDER", "utf8");
    const otherRegistration = {
      ...registration,
      accountId: "syntheticbank-account",
      instrumentId: "syntheticbank-instrument",
    } as ImportAccountRegistration;
    const row = postedRow("1", "a".repeat(64));
    row.observations[0] = {
      ...row.observations[0]!,
      provider: "syntheticbank",
      accountId: otherRegistration.accountId,
      instrumentId: otherRegistration.instrumentId,
    };

    await repository.commitImport({
      artifact: { bytes, sha256: sha(bytes.toString("utf8")), parserKind: "monobank_personal", parserVersion: "syntheticbank@1" },
      normalization: { kind: "monobank_personal", rows: [row] },
      registrations: [otherRegistration],
      provider: { code: "syntheticbank", displayName: "Synthetic Bank" },
    });

    expect(await database.get<{ provider: string }>(`
      SELECT provider.code AS provider
      FROM accounts account
      JOIN providers provider ON provider.id = account.provider_id
      WHERE account.id = ?
    `, [otherRegistration.accountId])).toEqual({ provider: "syntheticbank" });
  });
});

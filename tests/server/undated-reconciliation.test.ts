import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openEncryptedDatabase, type EncryptedDatabase } from "@/server/db/database";
import { applyMigrations } from "@/server/db/migrations";
import { UndatedReconciliationService } from "@/server/reconciliation/undated-service";
import { MovementService } from "@/server/movements/service";

describe("undated FOP reconciliation", () => {
  let directory: string;
  let database: EncryptedDatabase;
  let service: UndatedReconciliationService;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "moneywave-undated-"));
    database = await openEncryptedDatabase(join(directory, "moneywave.db"), Buffer.alloc(32, 101));
    await applyMigrations(database);
    service = new UndatedReconciliationService(database);
    await database.run("INSERT INTO providers (id, code, display_name) VALUES ('provider-privatbank', 'privatbank', 'PrivatBank')");
    await database.run("INSERT INTO accounts (id, provider_id, owner_scope, account_type, currency, display_name, identifier_hmac) VALUES ('fop-uah', 'provider-privatbank', 'SOLE_PROPRIETOR', 'business', 'UAH', 'FOP UAH', ?)", ["a".repeat(64)]);
    await database.run("INSERT INTO accounts (id, provider_id, owner_scope, account_type, currency, display_name, identifier_hmac) VALUES ('personal-uah', 'provider-privatbank', 'PERSONAL', 'card', 'UAH', 'Personal UAH', ?)", ["b".repeat(64)]);
  });

  afterEach(async () => {
    await database.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });

  async function addBatch(input: { id: string; parserKind: string; rowState: "posted" | "unresolved"; posted: number; unresolved: number }): Promise<string> {
    const artifactId = `artifact-${input.id}`;
    const sourceId = `source-${input.id}`;
    await database.run(
      "INSERT INTO import_artifacts (id, sha256, encrypted_bytes, size_bytes, parser_kind, parser_version) VALUES (?, ?, ?, 1, ?, 'synthetic@1')",
      [artifactId, input.id.padEnd(64, "0"), Buffer.from("S"), input.parserKind],
    );
    await database.run(
      "INSERT INTO import_batches (id, artifact_id, status, row_count, posted_count, non_posted_count, unresolved_count, rejected_count) VALUES (?, ?, 'committed', 1, ?, 0, ?, 0)",
      [`batch-${input.id}`, artifactId, input.posted, input.unresolved],
    );
    await database.run(
      "INSERT INTO source_records (id, batch_id, source_row_number, dedupe_fingerprint, row_state, reason_code) VALUES (?, ?, 1, ?, ?, ?)",
      [sourceId, `batch-${input.id}`, input.id.padEnd(64, "1"), input.rowState, input.rowState === "unresolved" ? "CONDUCTED_DATE_MISSING" : null],
    );
    return sourceId;
  }

  async function addPersonalEvidence(sourceId: string, entryId: string, occurredAt: string): Promise<void> {
    await database.run(
      "INSERT INTO ledger_entries (id, account_id, amount_minor, currency, direction, occurred_at, entry_kind) VALUES (?, 'personal-uah', 10000, 'UAH', 'credit', ?, 'unclassified')",
      [entryId, occurredAt],
    );
    await database.run(
      "INSERT INTO transaction_evidence (id, ledger_entry_id, source_record_id, observed_amount_minor, observed_currency, observed_direction, own_identifier_hmac) VALUES (?, ?, ?, 10000, 'UAH', 'credit', ?)",
      [randomUUID(), entryId, sourceId, "b".repeat(64)],
    );
  }

  async function addUndatedInternalSource(id: string): Promise<string> {
    const sourceId = await addBatch({ id, parserKind: "privat_fop_journal", rowState: "unresolved", posted: 0, unresolved: 1 });
    await database.run(
      `INSERT INTO unresolved_observations
        (id, source_record_id, position, account_id, amount_minor, currency, direction, own_identifier_hmac, counterparty_identifier_hmac, private_description)
       VALUES (?, ?, 0, 'fop-uah', -10000, 'UAH', 'debit', ?, ?, 'SYNTHETIC OWNER DRAW'),
              (?, ?, 1, 'personal-uah', 10000, 'UAH', 'credit', ?, ?, 'SYNTHETIC OWNER DRAW')`,
      [randomUUID(), sourceId, "a".repeat(64), "b".repeat(64), randomUUID(), sourceId, "b".repeat(64), "a".repeat(64)],
    );
    return sourceId;
  }

  it("uses one exact personal-statement match as date evidence for every leg in the unresolved FOP row", async () => {
    const fopSource = await addUndatedInternalSource("fop");
    const personalSource = await addBatch({ id: "personal", parserKind: "privat_personal", rowState: "posted", posted: 1, unresolved: 0 });
    await addPersonalEvidence(personalSource, "personal-credit", "2099-01-02T12:00:00");

    const result = await service.refresh();

    expect(result).toEqual({ resolvedRows: 1, ambiguousRows: 0, pendingRows: 0 });
    expect(await database.get<{ state: string; reason: string }>(
      "SELECT row_state AS state, reason_code AS reason FROM source_records WHERE id = ?",
      [fopSource],
    )).toEqual({ state: "posted", reason: "CONDUCTED_DATE_RESOLVED_FROM_STATEMENT" });
    expect(await database.get<{ posted: number; unresolved: number }>(
      "SELECT posted_count AS posted, unresolved_count AS unresolved FROM import_batches WHERE id = 'batch-fop'",
    )).toEqual({ posted: 1, unresolved: 0 });
    expect(await database.get<{ count: number }>("SELECT count(*) AS count FROM ledger_entries")).toEqual({ count: 2 });
    expect(await database.get<{ count: number }>("SELECT count(*) AS count FROM transaction_evidence WHERE ledger_entry_id = 'personal-credit'")).toEqual({ count: 2 });
    expect(await database.get<{ count: number }>("SELECT count(*) AS count FROM unresolved_observations WHERE status = 'resolved'")).toEqual({ count: 2 });
    expect(await new MovementService(database).refresh()).toMatchObject({ confirmedCreated: 1 });
    expect(await database.get<{ evidenceKind: string }>(
      "SELECT evidence_kind AS evidenceKind FROM movement_groups",
    )).toEqual({ evidenceKind: "same_source_record" });
  });

  it("keeps the date unresolved when identical personal evidence has more than one possible timestamp", async () => {
    const fopSource = await addUndatedInternalSource("ambiguous-fop");
    const firstSource = await addBatch({ id: "personal-a", parserKind: "privat_personal", rowState: "posted", posted: 1, unresolved: 0 });
    const secondSource = await addBatch({ id: "personal-b", parserKind: "privat_personal", rowState: "posted", posted: 1, unresolved: 0 });
    await addPersonalEvidence(firstSource, "personal-credit-a", "2099-01-02T12:00:00");
    await addPersonalEvidence(secondSource, "personal-credit-b", "2099-01-03T12:00:00");

    const result = await service.refresh();

    expect(result).toEqual({ resolvedRows: 0, ambiguousRows: 1, pendingRows: 0 });
    expect(await database.get<{ state: string; reason: string }>(
      "SELECT row_state AS state, reason_code AS reason FROM source_records WHERE id = ?",
      [fopSource],
    )).toEqual({ state: "unresolved", reason: "CONDUCTED_DATE_MATCH_AMBIGUOUS" });
    expect(await database.get<{ count: number }>("SELECT count(*) AS count FROM ledger_entries")).toEqual({ count: 2 });
  });

  it("accepts an explicit manual date without treating it as statement evidence", async () => {
    const sourceId = await addUndatedInternalSource("manual-fop");

    const result = await service.resolveManually(sourceId, "2099-01-04T09:30:00");

    expect(result).toEqual({ resolvedRows: 1, canonicalEntriesCreated: 2, evidenceMerged: 0 });
    expect(await database.all<{ kind: string }>(
      "SELECT DISTINCT resolution_kind AS kind FROM unresolved_observations WHERE source_record_id = ?",
      [sourceId],
    )).toEqual([{ kind: "manual" }]);
  });

  it("propagates one canonical date resolution to overlapping undated source evidence", async () => {
    const canonicalSource = await addUndatedInternalSource("canonical-fop");
    const duplicateSource = await addBatch({ id: "duplicate-fop", parserKind: "privat_fop_journal", rowState: "unresolved", posted: 0, unresolved: 1 });
    await database.run(
      "UPDATE source_records SET duplicate_of_source_record_id = ? WHERE id = ?",
      [canonicalSource, duplicateSource],
    );

    await service.resolveManually(canonicalSource, "2099-01-05T11:00:00");

    expect(await database.get<{ state: string; reason: string }>(
      "SELECT row_state AS state, reason_code AS reason FROM source_records WHERE id = ?",
      [duplicateSource],
    )).toEqual({ state: "posted", reason: "DUPLICATE_RESOLVED_WITH_CANONICAL" });
    expect(await database.get<{ posted: number; unresolved: number }>(
      "SELECT posted_count AS posted, unresolved_count AS unresolved FROM import_batches WHERE id = 'batch-duplicate-fop'",
    )).toEqual({ posted: 1, unresolved: 0 });
    expect(await database.get<{ count: number }>(
      "SELECT count(*) AS count FROM transaction_evidence WHERE source_record_id = ?",
      [duplicateSource],
    )).toEqual({ count: 2 });
    expect(await database.get<{ count: number }>("SELECT count(*) AS count FROM ledger_entries")).toEqual({ count: 2 });
  });

  it("resolves an overlapping undated source imported after its canonical evidence was already dated", async () => {
    const canonicalSource = await addUndatedInternalSource("resolved-first");
    await service.resolveManually(canonicalSource, "2099-01-06T11:00:00");
    const duplicateSource = await addBatch({ id: "imported-later", parserKind: "privat_fop_journal", rowState: "unresolved", posted: 0, unresolved: 1 });
    await database.run(
      "UPDATE source_records SET duplicate_of_source_record_id = ? WHERE id = ?",
      [canonicalSource, duplicateSource],
    );

    expect(await service.refresh()).toMatchObject({ resolvedRows: 1 });
    expect(await database.get<{ state: string }>("SELECT row_state AS state FROM source_records WHERE id = ?", [duplicateSource]))
      .toEqual({ state: "posted" });
    expect(await database.get<{ count: number }>(
      "SELECT count(*) AS count FROM transaction_evidence WHERE source_record_id = ?",
      [duplicateSource],
    )).toEqual({ count: 2 });
  });
});

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openEncryptedDatabase, type EncryptedDatabase } from "@/server/db/database";
import { applyMigrations } from "@/server/db/migrations";
import { AutonomousReconciliationService } from "@/server/reconciliation/autonomous-service";

describe("autonomous reconciliation", () => {
  let directory: string;
  let database: EncryptedDatabase;
  let service: AutonomousReconciliationService;
  let batchId: string;
  let rowNumber: number;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "moneywave-auto-reconcile-"));
    database = await openEncryptedDatabase(join(directory, "moneywave.db"), Buffer.alloc(32, 74));
    await applyMigrations(database);
    service = new AutonomousReconciliationService(database);
    rowNumber = 0;
    await database.run("INSERT INTO providers (id, code, display_name) VALUES ('provider-synthetic', 'privatbank', 'Synthetic')");
    await database.run("INSERT INTO providers (id, code, display_name) VALUES ('provider-mono', 'monobank', 'Synthetic Mono')");
    for (const [id, scope, currency, hash] of [
      ["fop-uah", "SOLE_PROPRIETOR", "UAH", "a".repeat(64)],
      ["fop-usd", "SOLE_PROPRIETOR", "USD", "b".repeat(64)],
      ["personal-one", "PERSONAL", "UAH", "c".repeat(64)],
      ["personal-two", "PERSONAL", "UAH", "d".repeat(64)],
      ["personal-eur", "PERSONAL", "EUR", "e".repeat(64)],
    ] as const) {
      await database.run(
        "INSERT INTO accounts (id, provider_id, owner_scope, account_type, currency, display_name, identifier_hmac) VALUES (?, 'provider-synthetic', ?, 'synthetic', ?, ?, ?)",
        [id, scope, currency, `Synthetic ${id}`, hash],
      );
    }
    await database.run(
      "INSERT INTO accounts (id, provider_id, owner_scope, account_type, currency, display_name, identifier_hmac) VALUES ('mono-uah', 'provider-mono', 'PERSONAL', 'synthetic', 'UAH', 'Synthetic mono', ?)",
      ["9".repeat(64)],
    );
    const artifactId = randomUUID();
    batchId = randomUUID();
    await database.run(
      "INSERT INTO import_artifacts (id, sha256, encrypted_bytes, size_bytes, parser_kind, parser_version) VALUES (?, ?, ?, 9, 'privat_personal', '1')",
      [artifactId, "f".repeat(64), Buffer.from("SYNTHETIC")],
    );
    await database.run("INSERT INTO import_batches (id, artifact_id, status, row_count) VALUES (?, ?, 'committed', 20)", [batchId, artifactId]);
  });

  afterEach(async () => {
    await database.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });

  async function addEntry(input: {
    id: string;
    accountId: string;
    amountMinor: bigint;
    direction: "debit" | "credit";
    currency?: string;
    occurredAt?: string;
    description?: string;
    sourceCategory?: string | null;
    sourceId?: string;
    kind?: string;
  }): Promise<string> {
    rowNumber += 1;
    const sourceId = input.sourceId ?? randomUUID();
    await database.run(
      "INSERT OR IGNORE INTO source_records (id, batch_id, source_row_number, dedupe_fingerprint, row_state, source_metadata_json) VALUES (?, ?, ?, ?, 'posted', ?)",
      [sourceId, batchId, rowNumber, randomUUID().replaceAll("-", "").padEnd(64, "0").slice(0, 64), JSON.stringify({ sourceCategory: input.sourceCategory === undefined ? "Synthetic transfer" : input.sourceCategory })],
    );
    await database.run(
      "INSERT INTO ledger_entries (id, account_id, amount_minor, currency, direction, occurred_at, entry_kind, private_description) VALUES (?, ?, CAST(? AS INTEGER), ?, ?, ?, ?, ?)",
      [input.id, input.accountId, input.amountMinor.toString(), input.currency ?? "UAH", input.direction, input.occurredAt ?? "2099-03-04T10:00:00.000Z", input.kind ?? "unclassified", input.description ?? "SYNTHETIC TRANSFER"],
    );
    await database.run(
      "INSERT INTO transaction_evidence (id, ledger_entry_id, source_record_id, observed_amount_minor, observed_currency, observed_direction) VALUES (?, ?, ?, CAST(? AS INTEGER), ?, ?)",
      [randomUUID(), input.id, sourceId, input.amountMinor.toString(), input.currency ?? "UAH", input.direction],
    );
    return sourceId;
  }

  async function addPendingCandidate(id: string, debitId: string, creditId: string, kind: "exact" | "near_amount" | "cross_currency"): Promise<void> {
    await database.run(
      "INSERT INTO movement_candidates (id, debit_entry_id, credit_entry_id, match_kind) VALUES (?, ?, ?, ?)",
      [id, debitId, creditId, kind],
    );
  }

  it("confirms a unique exact owner draw, closes competing candidates, and is idempotent", async () => {
    await addEntry({ id: "debit", accountId: "fop-uah", amountMinor: -50_000n, direction: "debit" });
    await addEntry({ id: "credit", accountId: "personal-one", amountMinor: 50_000n, direction: "credit", occurredAt: "2099-03-04T10:03:00.000Z" });
    await addEntry({ id: "other-credit", accountId: "personal-two", amountMinor: 49_900n, direction: "credit" });
    await addPendingCandidate("candidate-match", "debit", "credit", "exact");
    await addPendingCandidate("candidate-other", "debit", "other-credit", "near_amount");

    const result = await service.run();

    expect(result).toMatchObject({ confirmed: 1, rejectedCandidates: 1, pendingCandidates: 0 });
    expect(await database.all<{ kind: string }>("SELECT leg_kind AS kind FROM movement_legs ORDER BY position")).toEqual([
      { kind: "owner_draw" },
      { kind: "transfer_in" },
    ]);
    expect(await database.get<{ status: string }>("SELECT status FROM movement_candidates WHERE id = 'candidate-match'")).toEqual({ status: "confirmed" });
    expect(await database.get<{ status: string }>("SELECT status FROM movement_candidates WHERE id = 'candidate-other'")).toEqual({ status: "rejected" });
    expect(await service.run()).toMatchObject({ confirmed: 0, pendingCandidates: 0 });
  });

  it("rejects an ambiguous pending queue without inventing a link", async () => {
    await addEntry({ id: "debit", accountId: "fop-uah", amountMinor: -20_000n, direction: "debit" });
    await addEntry({ id: "credit-one", accountId: "personal-one", amountMinor: 20_000n, direction: "credit" });
    await addEntry({ id: "credit-two", accountId: "personal-two", amountMinor: 20_000n, direction: "credit" });
    await addPendingCandidate("candidate-one", "debit", "credit-one", "exact");
    await addPendingCandidate("candidate-two", "debit", "credit-two", "exact");

    const result = await service.run();

    expect(result).toMatchObject({ confirmed: 0, rejectedCandidates: 2, ambiguousEntries: 3, pendingCandidates: 0 });
    expect(await database.get<{ count: number }>("SELECT count(*) AS count FROM movement_groups")).toEqual({ count: 0 });
    expect(await database.get<{ count: number }>("SELECT count(*) AS count FROM audit_events WHERE event_code = 'MOVEMENT_CANDIDATE_INSUFFICIENT_EVIDENCE'")).toEqual({ count: 2 });
  });

  it("reports only unresolved movement boundaries as unmatched", async () => {
    await addEntry({
      id: "ordinary-purchase",
      accountId: "personal-one",
      amountMinor: -2_500n,
      direction: "debit",
      kind: "terminal_personal_expense",
      description: "SYNTHETIC TRANSFER TO FRIEND",
      sourceCategory: "P2P expense",
    });
    await addEntry({
      id: "external-transfer",
      accountId: "personal-two",
      amountMinor: -25_000n,
      direction: "debit",
      kind: "unlinked_transfer_out",
      description: "SYNTHETIC TRANSFER TO EXTERNAL ACCOUNT",
    });
    await addEntry({
      id: "named-external-load",
      accountId: "personal-one",
      amountMinor: -30_000n,
      direction: "debit",
      kind: "unclassified",
      description: "SYNTHETIC REVOLUT CARD LOAD",
      sourceCategory: null,
    });

    expect(await service.run()).toMatchObject({ confirmed: 0, ambiguousEntries: 0, unmatchedEntries: 2 });
  });

  it("stores a near-amount residual as an unexplained gap rather than a fee", async () => {
    await addEntry({ id: "debit", accountId: "personal-one", amountMinor: -100_000n, direction: "debit" });
    await addEntry({ id: "credit", accountId: "personal-two", amountMinor: 99_000n, direction: "credit", occurredAt: "2099-03-04T10:02:00.000Z" });
    await addPendingCandidate("candidate", "debit", "credit", "near_amount");

    expect(await service.run()).toMatchObject({ confirmed: 1, unexplainedGaps: 1 });
    expect(await database.get<{ method: string; amount: string }>(
      "SELECT method, CAST(amount_minor AS TEXT) AS amount FROM cost_components",
    )).toEqual({ method: "unexplained_gap", amount: "1000" });
  });

  it("uses a shared source row as hard evidence for an FX pair", async () => {
    const shared = randomUUID();
    await addEntry({ id: "sell", accountId: "fop-usd", amountMinor: -10_000n, currency: "USD", direction: "debit", sourceId: shared, description: "SYNTHETIC FX" });
    await addEntry({ id: "buy", accountId: "fop-uah", amountMinor: 400_000n, currency: "UAH", direction: "credit", sourceId: shared, description: "SYNTHETIC FX" });
    await addPendingCandidate("candidate", "sell", "buy", "cross_currency");

    expect(await service.run()).toMatchObject({ confirmed: 1, fxConversions: 1 });
    expect(await database.get<{ evidence: string }>("SELECT evidence_kind AS evidence FROM movement_groups")).toEqual({ evidence: "same_source_record" });
    expect(await database.get<{ count: number }>("SELECT count(*) AS count FROM fx_conversions")).toEqual({ count: 1 });
  });

  it("uses a masked owned-account hint plus an official-rate check for automatic FX", async () => {
    await database.run(
      "INSERT INTO account_instruments (id, account_id, instrument_kind, identifier_hmac, masked_display) VALUES ('instrument-eur', 'personal-eur', 'card', ?, '•••• 4242')",
      ["1".repeat(64)],
    );
    await addEntry({ id: "sell", accountId: "fop-uah", amountMinor: -100_000n, currency: "UAH", direction: "debit", description: "SYNTHETIC TRANSFER TO 4242" });
    await addEntry({ id: "buy", accountId: "personal-eur", amountMinor: 2_400n, currency: "EUR", direction: "credit", occurredAt: "2099-03-04T10:02:00.000Z", description: "SYNTHETIC FROM OWN CARD" });
    const rateAware = new AutonomousReconciliationService(database, {
      benchmark: async () => ({ rate: "0.024", source: "ECB", publicationDate: "2099-03-04" }),
    });

    expect(await rateAware.run()).toMatchObject({ confirmed: 1, fxConversions: 1 });
    expect(await database.get<{ evidence: string }>("SELECT evidence_kind AS evidence FROM movement_groups")).toEqual({ evidence: "account_hint" });
  });

  it("reconsiders previously unlinked transfer rows when a later source supplies the counterpart", async () => {
    await addEntry({ id: "older-debit", accountId: "personal-one", amountMinor: -30_000n, direction: "debit" });
    await addEntry({ id: "later-credit", accountId: "personal-two", amountMinor: 30_000n, direction: "credit", occurredAt: "2099-03-04T10:02:00.000Z" });
    await database.run("UPDATE ledger_entries SET entry_kind = CASE direction WHEN 'debit' THEN 'unlinked_transfer_out' ELSE 'unlinked_transfer_in' END");
    await addPendingCandidate("old-candidate", "older-debit", "later-credit", "exact");
    await database.run("UPDATE movement_candidates SET status = 'rejected', reviewed_at = '2099-03-04T11:00:00.000Z' WHERE id = 'old-candidate'");

    expect(await service.run()).toMatchObject({ confirmed: 1, pendingCandidates: 0 });
    expect(await database.get<{ status: string }>("SELECT status FROM movement_candidates WHERE id = 'old-candidate'"))
      .toEqual({ status: "confirmed" });
  });

  it("links an already classified cross-provider endpoint and removes its automatic category", async () => {
    await addEntry({
      id: "privat-out",
      accountId: "personal-one",
      amountMinor: -30_000n,
      direction: "debit",
      kind: "unlinked_transfer_out",
    });
    await addEntry({
      id: "mono-in",
      accountId: "mono-uah",
      amountMinor: 30_000n,
      direction: "credit",
      kind: "personal_income",
      description: "SYNTHETIC CREDIT",
      occurredAt: "2099-03-04T10:05:00.000Z",
    });
    await database.run(
      "INSERT INTO category_assignments (id, ledger_entry_id, category_id, method, classification_version) VALUES (?, 'mono-in', 'personal-income', 'deterministic', 'canonical-v2')",
      [randomUUID()],
    );

    expect(await service.run()).toMatchObject({ confirmed: 1 });
    expect(await database.get<{ count: number }>(
      "SELECT count(*) AS count FROM category_assignments WHERE ledger_entry_id = 'mono-in'",
    )).toEqual({ count: 0 });
    expect(await database.all<{ kind: string }>("SELECT entry_kind AS kind FROM ledger_entries WHERE id IN ('privat-out', 'mono-in') ORDER BY id"))
      .toEqual([{ kind: "transfer_in" }, { kind: "transfer_out" }]);
  });
});

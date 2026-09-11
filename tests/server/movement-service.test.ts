import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openEncryptedDatabase, type EncryptedDatabase } from "@/server/db/database";
import { applyMigrations } from "@/server/db/migrations";
import { MovementService } from "@/server/movements/service";

describe("persistent movement reconciliation", () => {
  let directory: string;
  let database: EncryptedDatabase;
  let service: MovementService;
  let batchId: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "moneywave-movement-test-"));
    database = await openEncryptedDatabase(join(directory, "moneywave.db"), Buffer.alloc(32, 51));
    await applyMigrations(database);
    service = new MovementService(database);
    await database.run("INSERT INTO providers (id, code, display_name) VALUES (?, ?, ?)", ["provider-synthetic", "privatbank", "Synthetic Provider"]);
    for (const [id, scope, hash] of [
      ["account-fop", "SOLE_PROPRIETOR", "a".repeat(64)],
      ["account-personal", "PERSONAL", "b".repeat(64)],
      ["account-other-one", "PERSONAL", "c".repeat(64)],
      ["account-other-two", "PERSONAL", "d".repeat(64)],
    ] as const) {
      await database.run(
        "INSERT INTO accounts (id, provider_id, owner_scope, account_type, currency, display_name, identifier_hmac) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [id, "provider-synthetic", scope, "synthetic", "UAH", `Synthetic ${id}`, hash],
      );
    }
    const artifactId = randomUUID();
    batchId = randomUUID();
    await database.run(
      "INSERT INTO import_artifacts (id, sha256, encrypted_bytes, size_bytes, parser_kind, parser_version) VALUES (?, ?, ?, ?, ?, ?)",
      [artifactId, "f".repeat(64), Buffer.from("SYNTHETIC"), 9, "privat_personal", "1"],
    );
    await database.run(
      "INSERT INTO import_batches (id, artifact_id, status, row_count) VALUES (?, ?, 'committed', 4)",
      [batchId, artifactId],
    );
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
    sourceId: string;
    providerReference?: string;
    ownHash?: string;
    counterpartyHash?: string;
    occurredAt?: string;
  }): Promise<void> {
    await database.run(
      "INSERT INTO source_records (id, batch_id, source_row_number, dedupe_fingerprint, row_state) VALUES (?, ?, ?, ?, 'posted')",
      [input.sourceId, batchId, Number(input.id.replace(/\D/g, "")) || 1, randomUUID().replaceAll("-", "").padEnd(64, "0").slice(0, 64)],
    );
    await database.run(
      "INSERT INTO ledger_entries (id, account_id, amount_minor, currency, direction, occurred_at, entry_kind) VALUES (?, ?, CAST(? AS INTEGER), 'UAH', ?, ?, 'unclassified')",
      [input.id, input.accountId, input.amountMinor.toString(), input.direction, input.occurredAt ?? "2099-01-01T10:00:00"],
    );
    await database.run(
      "INSERT INTO transaction_evidence (id, ledger_entry_id, source_record_id, observed_amount_minor, observed_currency, observed_direction, own_identifier_hmac, counterparty_identifier_hmac, provider_reference) VALUES (?, ?, ?, CAST(? AS INTEGER), 'UAH', ?, ?, ?, ?)",
      [randomUUID(), input.id, input.sourceId, input.amountMinor.toString(), input.direction, input.ownHash ?? null, input.counterpartyHash ?? null, input.providerReference ?? null],
    );
  }

  it("persists evidence-confirmed groups and review-only exact candidates idempotently", async () => {
    await addEntry({ id: "entry-1", accountId: "account-fop", amountMinor: -10_000n, direction: "debit", sourceId: "source-1", providerReference: "SYNTH-REF" });
    await addEntry({ id: "entry-2", accountId: "account-personal", amountMinor: 10_000n, direction: "credit", sourceId: "source-2", providerReference: "SYNTH-REF" });
    await addEntry({ id: "entry-3", accountId: "account-other-one", amountMinor: -2_000n, direction: "debit", sourceId: "source-3", occurredAt: "2099-01-02T10:00:00" });
    await addEntry({ id: "entry-4", accountId: "account-other-two", amountMinor: 2_000n, direction: "credit", sourceId: "source-4", occurredAt: "2099-01-02T10:00:00" });

    expect(await service.refresh()).toMatchObject({ confirmedCreated: 1, candidatesCreated: 1 });
    expect(await database.get<{ count: number }>("SELECT count(*) AS count FROM movement_groups")).toEqual({ count: 1 });
    expect(await database.get<{ count: number }>("SELECT count(*) AS count FROM movement_legs")).toEqual({ count: 2 });
    expect(await database.get<{ count: number }>("SELECT count(*) AS count FROM movement_candidates WHERE status = 'pending'")).toEqual({ count: 1 });
    expect(await service.refresh()).toMatchObject({ confirmedCreated: 0, candidatesCreated: 0 });
  });

  it("turns a reviewed candidate into a manual evidence group and never calls it reconciled", async () => {
    await addEntry({ id: "entry-1", accountId: "account-other-one", amountMinor: -2_000n, direction: "debit", sourceId: "source-1" });
    await addEntry({ id: "entry-2", accountId: "account-other-two", amountMinor: 2_000n, direction: "credit", sourceId: "source-2" });
    await service.refresh();
    const candidate = await database.get<{ id: string }>("SELECT id FROM movement_candidates WHERE status = 'pending'");
    const confirmed = await service.confirmCandidate(candidate!.id);

    expect(confirmed).toMatchObject({ evidenceKind: "manual", status: "confirmed" });
    expect(await database.get<{ status: string }>("SELECT status FROM movement_candidates WHERE id = ?", [candidate!.id])).toEqual({ status: "confirmed" });
    expect(await database.get<{ status: string }>("SELECT status FROM movement_groups WHERE id = ?", [confirmed.groupId])).toEqual({ status: "confirmed" });
    expect(await database.get<{ event_code: string }>("SELECT event_code FROM audit_events WHERE entity_id = ?", [candidate!.id])).toEqual({ event_code: "MOVEMENT_CANDIDATE_CONFIRMED" });
  });

  it("attaches one unlinked statement-fee entry as an additional movement leg exactly once", async () => {
    await addEntry({ id: "entry-1", accountId: "account-fop", amountMinor: -10_000n, direction: "debit", sourceId: "source-1", providerReference: "SYNTH-FEE-GROUP" });
    await addEntry({ id: "entry-2", accountId: "account-personal", amountMinor: 10_000n, direction: "credit", sourceId: "source-2", providerReference: "SYNTH-FEE-GROUP" });
    await addEntry({ id: "entry-3", accountId: "account-personal", amountMinor: -100n, direction: "debit", sourceId: "source-3" });
    await database.run("UPDATE ledger_entries SET entry_kind = 'explicit_fee' WHERE id = 'entry-3'");
    await service.refresh();
    const group = await database.get<{ id: string }>("SELECT id FROM movement_groups");

    await expect(service.attachExplicitFee(group!.id, "entry-3")).resolves.toEqual({ attached: true });
    expect(await database.all<{ entryId: string; kind: string; position: number }>(
      "SELECT ledger_entry_id AS entryId, leg_kind AS kind, position FROM movement_legs WHERE movement_group_id = ? ORDER BY position",
      [group!.id],
    )).toEqual([
      { entryId: "entry-1", kind: "owner_draw", position: 0 },
      { entryId: "entry-2", kind: "transfer_in", position: 1 },
      { entryId: "entry-3", kind: "explicit_fee", position: 2 },
    ]);
    expect(await database.get<{ status: string }>("SELECT reconciliation_status AS status FROM ledger_entries WHERE id = 'entry-3'"))
      .toEqual({ status: "confirmed" });
    await expect(service.attachExplicitFee(group!.id, "entry-3")).rejects.toThrow("MOVEMENT_ENTRY_ALREADY_LINKED");
  });
});

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openEncryptedDatabase, type EncryptedDatabase } from "@/server/db/database";
import { applyMigrations } from "@/server/db/migrations";
import { ProviderFxEvidenceService } from "@/server/reconciliation/provider-fx-evidence";

describe("provider FX evidence materialization", () => {
  let directory: string;
  let database: EncryptedDatabase;
  let sourceId: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "moneywave-provider-fx-"));
    database = await openEncryptedDatabase(join(directory, "moneywave.db"), Buffer.alloc(32, 92));
    await applyMigrations(database);
    await database.run("INSERT INTO providers (id, code, display_name) VALUES ('provider', 'privatbank', 'Synthetic')");
    await database.run("INSERT INTO accounts (id, provider_id, owner_scope, account_type, currency, display_name, identifier_hmac) VALUES ('fop-uah', 'provider', 'SOLE_PROPRIETOR', 'bank', 'UAH', 'FOP UAH', ?)", ["a".repeat(64)]);
    await database.run("INSERT INTO accounts (id, provider_id, owner_scope, account_type, currency, display_name, identifier_hmac) VALUES ('personal-eur', 'provider', 'PERSONAL', 'card', 'EUR', 'Personal EUR', ?)", ["b".repeat(64)]);
    const artifactId = randomUUID();
    const batchId = randomUUID();
    sourceId = randomUUID();
    await database.run("INSERT INTO import_artifacts (id, sha256, encrypted_bytes, size_bytes, parser_kind, parser_version) VALUES (?, ?, ?, 9, 'privat_fop_journal', '1')", [artifactId, "f".repeat(64), Buffer.from("SYNTHETIC")]);
    await database.run("INSERT INTO import_batches (id, artifact_id, status, row_count) VALUES (?, ?, 'committed', 1)", [batchId, artifactId]);
    await database.run("INSERT INTO source_records (id, batch_id, source_row_number, dedupe_fingerprint, row_state) VALUES (?, ?, 1, ?, 'posted')", [sourceId, batchId, "e".repeat(64)]);
  });

  afterEach(async () => {
    await database.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });

  async function addProceeds(id = "proceeds", description = "Гривнi вiд продажу 1 000.00 USD по курсу 40.00"): Promise<void> {
    await database.run("INSERT INTO ledger_entries (id, account_id, amount_minor, currency, direction, occurred_at, entry_kind, private_description) VALUES (?, 'fop-uah', 4000000, 'UAH', 'credit', '2099-01-01T10:00:00', 'unlinked_transfer_in', ?)", [id, description]);
    await database.run("INSERT INTO transaction_evidence (id, ledger_entry_id, source_record_id, observed_amount_minor, observed_currency, observed_direction) VALUES (?, ?, ?, 4000000, 'UAH', 'credit')", [randomUUID(), id, sourceId]);
  }

  it("creates a one-sided conversion from provider-stated USD sale evidence", async () => {
    await addProceeds();
    const service = new ProviderFxEvidenceService(database);

    expect(await service.run()).toEqual({ parsed: 1, confirmed: 1, invalid: 0, revoked: 0 });
    expect(await database.get<{ evidence: string; status: string }>("SELECT evidence_kind AS evidence, status FROM movement_groups")).toEqual({ evidence: "provider_fx_description", status: "confirmed" });
    expect(await database.get<{ count: number }>("SELECT count(*) AS count FROM movement_legs")).toEqual({ count: 1 });
    expect(await database.get<{ sold: string; received: string; rate: string }>("SELECT CAST(sold_amount_minor AS TEXT) AS sold, CAST(received_amount_minor AS TEXT) AS received, executed_rate_text AS rate FROM fx_conversions")).toEqual({ sold: "100000", received: "4000000", rate: "40" });
    expect(await database.get<{ sourceAmount: string; sourceCurrency: string }>("SELECT CAST(source_amount_minor AS TEXT) AS sourceAmount, source_currency AS sourceCurrency FROM transaction_evidence")).toEqual({ sourceAmount: "100000", sourceCurrency: "USD" });
    expect(await service.run()).toEqual({ parsed: 1, confirmed: 0, invalid: 0, revoked: 0 });
  });

  it("rejects inconsistent description math", async () => {
    await addProceeds("invalid", "Гривнi вiд продажу 1 000.00 USD по курсу 20.00");

    expect(await new ProviderFxEvidenceService(database).run()).toEqual({ parsed: 1, confirmed: 0, invalid: 1, revoked: 0 });
    expect(await database.get<{ count: number }>("SELECT count(*) AS count FROM movement_groups")).toEqual({ count: 0 });
  });

  it("replaces a weaker heuristic pair before materializing provider evidence", async () => {
    await addProceeds();
    await database.run("INSERT INTO ledger_entries (id, account_id, amount_minor, currency, direction, occurred_at, entry_kind, reconciliation_status) VALUES ('heuristic-debit', 'personal-eur', -100000, 'EUR', 'debit', '2099-01-01T09:59:00', 'fx_sell', 'confirmed')");
    await database.run("UPDATE ledger_entries SET entry_kind = 'fx_buy', reconciliation_status = 'confirmed' WHERE id = 'proceeds'");
    await database.run("INSERT INTO movement_groups (id, status, evidence_kind) VALUES ('heuristic', 'confirmed', 'automatic_fx')");
    await database.run("INSERT INTO movement_legs (id, movement_group_id, ledger_entry_id, leg_kind, position) VALUES (?, 'heuristic', 'heuristic-debit', 'fx_sell', 0), (?, 'heuristic', 'proceeds', 'fx_buy', 1)", [randomUUID(), randomUUID()]);
    await database.run("INSERT INTO fx_conversions (id, movement_group_id, sold_amount_minor, sold_currency, received_amount_minor, received_currency, executed_rate_text, formula_version) VALUES (?, 'heuristic', 100000, 'EUR', 4000000, 'UAH', '40', 'executed_rate_v1')", [randomUUID()]);

    expect(await new ProviderFxEvidenceService(database).run()).toEqual({ parsed: 1, confirmed: 1, invalid: 0, revoked: 1 });
    expect(await database.all<{ evidence: string }>("SELECT evidence_kind AS evidence FROM movement_groups")).toEqual([{ evidence: "provider_fx_description" }]);
    expect(await database.get<{ kind: string; status: string }>("SELECT entry_kind AS kind, reconciliation_status AS status FROM ledger_entries WHERE id = 'heuristic-debit'")).toEqual({ kind: "unclassified", status: "unlinked" });
  });
});

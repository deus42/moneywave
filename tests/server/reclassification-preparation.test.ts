import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ReclassificationPreparationService } from "@/server/categorization/reclassification-preparation";
import { openEncryptedDatabase, type EncryptedDatabase } from "@/server/db/database";
import { applyMigrations } from "@/server/db/migrations";

describe("legacy automatic classification preparation", () => {
  let directory: string;
  let database: EncryptedDatabase;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "moneywave-reclassification-"));
    database = await openEncryptedDatabase(join(directory, "moneywave.db"), Buffer.alloc(32, 71));
    await applyMigrations(database);
    await database.run("INSERT INTO providers (id, code, display_name) VALUES ('provider', 'synthetic', 'Synthetic')");
    await database.run("INSERT INTO accounts (id, provider_id, owner_scope, account_type, currency, display_name, identifier_hmac) VALUES ('fop', 'provider', 'SOLE_PROPRIETOR', 'business', 'UAH', 'FOP', ?)", ["a".repeat(64)]);
  });

  afterEach(async () => {
    await database.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });

  it("returns legacy automatic FX/transfer classifications to the matcher and removes only automatic categories", async () => {
    await database.run("INSERT INTO ledger_entries (id, account_id, amount_minor, currency, direction, occurred_at, entry_kind, private_description) VALUES ('fx', 'fop', 400000, 'UAH', 'credit', '2099-01-01T10:00:00', 'business_income', 'SYNTHETIC Гривнi вiд продажу USD')");
    await database.run("INSERT INTO category_assignments (id, ledger_entry_id, category_id, method, needs_review) VALUES (?, 'fx', 'business-gross-income', 'deterministic', 0)", [randomUUID()]);

    const result = await new ReclassificationPreparationService(database).run();

    expect(result).toEqual({ resetEntries: 1, removedAutomaticAssignments: 1 });
    expect(await database.get<{ kind: string }>("SELECT entry_kind AS kind FROM ledger_entries WHERE id = 'fx'")).toEqual({ kind: "unclassified" });
    expect(await database.get<{ count: number }>("SELECT count(*) AS count FROM category_assignments WHERE ledger_entry_id = 'fx'")).toEqual({ count: 0 });
    expect(await new ReclassificationPreparationService(database).run()).toEqual({ resetEntries: 0, removedAutomaticAssignments: 0 });
  });

  it("does not reset terminal purchases or entries already linked into a movement", async () => {
    await database.run("INSERT INTO ledger_entries (id, account_id, amount_minor, currency, direction, occurred_at, entry_kind, private_description) VALUES ('purchase', 'fop', -1000, 'UAH', 'debit', '2099-01-01T10:00:00', 'business_expense', 'SYNTHETIC SHOP')");
    await database.run("INSERT INTO ledger_entries (id, account_id, amount_minor, currency, direction, occurred_at, entry_kind, private_description) VALUES ('linked', 'fop', -2000, 'UAH', 'debit', '2099-01-01T10:00:00', 'transfer_out', 'SYNTHETIC TRANSFER TO ACCOUNT')");
    await database.run("INSERT INTO movement_groups (id, status, evidence_kind) VALUES ('group', 'confirmed', 'same_source_record')");
    await database.run("INSERT INTO movement_legs (id, movement_group_id, ledger_entry_id, leg_kind, position) VALUES (?, 'group', 'linked', 'transfer_out', 0)", [randomUUID()]);

    expect(await new ReclassificationPreparationService(database).run()).toEqual({ resetEntries: 0, removedAutomaticAssignments: 0 });
  });

  it("returns generic transfers and mobile top-ups to classification but keeps explicit own transfers unlinked", async () => {
    await database.run("INSERT INTO ledger_entries (id, account_id, amount_minor, currency, direction, occurred_at, entry_kind, private_description) VALUES ('generic', 'fop', -1000, 'UAH', 'debit', '2099-01-01T10:00:00', 'unlinked_transfer_out', 'SYNTHETIC TRANSFER TO RECIPIENT')");
    await database.run("INSERT INTO ledger_entries (id, account_id, amount_minor, currency, direction, occurred_at, entry_kind, private_description) VALUES ('mobile', 'fop', -2000, 'UAH', 'debit', '2099-01-01T10:01:00', 'unlinked_transfer_out', 'SYNTHETIC MOBILE TOP UP')");
    await database.run("INSERT INTO ledger_entries (id, account_id, amount_minor, currency, direction, occurred_at, entry_kind, private_description) VALUES ('own', 'fop', -3000, 'UAH', 'debit', '2099-01-01T10:02:00', 'unlinked_transfer_out', 'SYNTHETIC TRANSFER BETWEEN OWN ACCOUNTS')");

    expect(await new ReclassificationPreparationService(database).run()).toEqual({ resetEntries: 2, removedAutomaticAssignments: 0 });
    expect(await database.all<{ id: string; kind: string }>("SELECT id, entry_kind AS kind FROM ledger_entries ORDER BY id")).toEqual([
      { id: "generic", kind: "unclassified" },
      { id: "mobile", kind: "unclassified" },
      { id: "own", kind: "unlinked_transfer_out" },
    ]);
  });

  it("returns a merchant payment with conversion from an unlinked FX classification", async () => {
    await database.run("INSERT INTO ledger_entries (id, account_id, amount_minor, currency, direction, occurred_at, entry_kind, private_description) VALUES ('converted-purchase', 'fop', -1000, 'UAH', 'debit', '2099-01-01T10:00:00', 'unlinked_transfer_out', 'СИНТЕТИЧНА ОПЛАТА З ПОДВІЙНОЮ КОНВЕРТАЦІЄЮ')");

    expect(await new ReclassificationPreparationService(database).run()).toEqual({ resetEntries: 1, removedAutomaticAssignments: 0 });
    expect(await database.get<{ kind: string }>("SELECT entry_kind AS kind FROM ledger_entries WHERE id = 'converted-purchase'"))
      .toEqual({ kind: "unclassified" });
  });

  it("returns a newly recognized external-account load to movement classification", async () => {
    await database.run("INSERT INTO ledger_entries (id, account_id, amount_minor, currency, direction, occurred_at, entry_kind, private_description) VALUES ('external-load', 'fop', -1000, 'UAH', 'debit', '2099-01-01T10:00:00', 'business_expense', 'SYNTHETIC REVOLUT CARD LOAD')");

    expect(await new ReclassificationPreparationService(database).run()).toEqual({ resetEntries: 1, removedAutomaticAssignments: 0 });
    expect(await database.get<{ kind: string }>("SELECT entry_kind AS kind FROM ledger_entries WHERE id = 'external-load'"))
      .toEqual({ kind: "unclassified" });
  });

  it("removes an automatic other assignment when a newer MCC rule is decisive", async () => {
    await database.run("INSERT INTO accounts (id, provider_id, owner_scope, account_type, currency, display_name, identifier_hmac) VALUES ('personal-mcc', 'provider', 'PERSONAL', 'card', 'UAH', 'Synthetic personal', ?)", ["c".repeat(64)]);
    const artifactId = randomUUID();
    const batchId = randomUUID();
    const sourceId = randomUUID();
    await database.run("INSERT INTO import_artifacts (id, sha256, encrypted_bytes, size_bytes, parser_kind, parser_version) VALUES (?, ?, ?, 9, 'synthetic', '1')", [artifactId, "f".repeat(64), Buffer.from("SYNTHETIC")]);
    await database.run("INSERT INTO import_batches (id, artifact_id, status, row_count) VALUES (?, ?, 'committed', 1)", [batchId, artifactId]);
    await database.run("INSERT INTO source_records (id, batch_id, source_row_number, dedupe_fingerprint, row_state, source_metadata_json) VALUES (?, ?, 1, ?, 'posted', ?)", [sourceId, batchId, "e".repeat(64), JSON.stringify({ mcc: "4829" })]);
    await database.run("INSERT INTO ledger_entries (id, account_id, amount_minor, currency, direction, occurred_at, entry_kind, private_description) VALUES ('new-mcc', 'personal-mcc', -1000, 'UAH', 'debit', '2099-01-01T10:00:00', 'terminal_personal_expense', 'SYNTHETIC RECIPIENT')");
    await database.run("INSERT INTO transaction_evidence (id, ledger_entry_id, source_record_id, observed_amount_minor, observed_currency, observed_direction) VALUES (?, 'new-mcc', ?, -1000, 'UAH', 'debit')", [randomUUID(), sourceId]);
    await database.run("INSERT INTO category_assignments (id, ledger_entry_id, category_id, method, classification_version) VALUES (?, 'new-mcc', 'personal-other', 'openai_codex', 'canonical-v2')", [randomUUID()]);

    expect(await new ReclassificationPreparationService(database).run()).toEqual({ resetEntries: 0, removedAutomaticAssignments: 1 });
    expect(await database.get<{ kind: string }>("SELECT entry_kind AS kind FROM ledger_entries WHERE id = 'new-mcc'"))
      .toEqual({ kind: "terminal_personal_expense" });
    expect(await database.get<{ count: number }>("SELECT count(*) AS count FROM category_assignments WHERE ledger_entry_id = 'new-mcc'"))
      .toEqual({ count: 0 });
  });

  it("removes an older automatic personal assignment once and preserves manual assignments", async () => {
    await database.run("INSERT INTO accounts (id, provider_id, owner_scope, account_type, currency, display_name, identifier_hmac) VALUES ('personal', 'provider', 'PERSONAL', 'card', 'UAH', 'Personal', ?)", ["b".repeat(64)]);
    await database.run("INSERT INTO ledger_entries (id, account_id, amount_minor, currency, direction, occurred_at, entry_kind, private_description) VALUES ('old-auto', 'personal', -1000, 'UAH', 'debit', '2099-01-01T10:00:00', 'terminal_personal_expense', 'SYNTHETIC SHOP')");
    await database.run("INSERT INTO ledger_entries (id, account_id, amount_minor, currency, direction, occurred_at, entry_kind, private_description) VALUES ('manual', 'personal', -1000, 'UAH', 'debit', '2099-01-01T10:01:00', 'terminal_personal_expense', 'SYNTHETIC SHOP')");
    await database.run("INSERT INTO category_assignments (id, ledger_entry_id, category_id, method, needs_review) VALUES (?, 'old-auto', 'personal-other', 'bank', 0)", [randomUUID()]);
    await database.run("INSERT INTO category_assignments (id, ledger_entry_id, category_id, method, needs_review) VALUES (?, 'manual', 'personal-health', 'manual', 0)", [randomUUID()]);

    expect(await new ReclassificationPreparationService(database).run()).toEqual({ resetEntries: 0, removedAutomaticAssignments: 1 });
    expect(await database.all<{ entryId: string }>("SELECT ledger_entry_id AS entryId FROM category_assignments ORDER BY ledger_entry_id"))
      .toEqual([{ entryId: "manual" }]);
    expect(await new ReclassificationPreparationService(database).run()).toEqual({ resetEntries: 0, removedAutomaticAssignments: 0 });
  });
});

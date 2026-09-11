import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AutomaticFxRepairService } from "@/server/reconciliation/automatic-fx-repair";
import { openEncryptedDatabase, type EncryptedDatabase } from "@/server/db/database";
import { applyMigrations } from "@/server/db/migrations";

describe("automatic FX repair", () => {
  let directory: string;
  let database: EncryptedDatabase;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "moneywave-fx-repair-"));
    database = await openEncryptedDatabase(join(directory, "moneywave.db"), Buffer.alloc(32, 91));
    await applyMigrations(database);
    await database.run("INSERT INTO providers (id, code, display_name) VALUES ('provider', 'synthetic', 'Synthetic')");
    await database.run("INSERT INTO accounts (id, provider_id, owner_scope, account_type, currency, display_name, identifier_hmac) VALUES ('uah', 'provider', 'PERSONAL', 'card', 'UAH', 'UAH', ?)", ["a".repeat(64)]);
    await database.run("INSERT INTO accounts (id, provider_id, owner_scope, account_type, currency, display_name, identifier_hmac) VALUES ('eur', 'provider', 'PERSONAL', 'card', 'EUR', 'EUR', ?)", ["b".repeat(64)]);
  });

  afterEach(async () => {
    await database.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });

  async function addFxGroup(id: string, evidenceKind: string, executedRate: string, benchmarkRate: string): Promise<void> {
    await database.run("INSERT INTO ledger_entries (id, account_id, amount_minor, currency, direction, occurred_at, entry_kind, reconciliation_status) VALUES (?, 'uah', -100000, 'UAH', 'debit', '2099-01-01T10:00:00', 'fx_sell', 'confirmed')", [`${id}-debit`]);
    await database.run("INSERT INTO ledger_entries (id, account_id, amount_minor, currency, direction, occurred_at, entry_kind, reconciliation_status) VALUES (?, 'eur', 2400, 'EUR', 'credit', '2099-01-01T10:01:00', 'fx_buy', 'confirmed')", [`${id}-credit`]);
    await database.run("INSERT INTO movement_groups (id, status, evidence_kind) VALUES (?, 'reconciled', ?)", [id, evidenceKind]);
    await database.run("INSERT INTO movement_legs (id, movement_group_id, ledger_entry_id, leg_kind, position) VALUES (?, ?, ?, 'fx_sell', 0), (?, ?, ?, 'fx_buy', 1)", [randomUUID(), id, `${id}-debit`, randomUUID(), id, `${id}-credit`]);
    await database.run("INSERT INTO fx_conversions (id, movement_group_id, sold_amount_minor, sold_currency, received_amount_minor, received_currency, executed_rate_text, benchmark_rate_text, benchmark_source, benchmark_publication_date, formula_version) VALUES (?, ?, 100000, 'UAH', 2400, 'EUR', ?, ?, 'ECB', '2099-01-01', 'fx-cost@1')", [randomUUID(), id, executedRate, benchmarkRate]);
  }

  it("revokes an implausible heuristic FX link and returns both entries to analysis", async () => {
    await addFxGroup("outlier", "automatic_fx", "0.1", "0.024");
    await database.run("INSERT INTO cost_components (id, movement_group_id, method, amount_minor, currency, estimated) VALUES (?, 'outlier', 'unexplained_gap', -7600, 'EUR', 0)", [randomUUID()]);
    await database.run("INSERT INTO movement_candidates (id, debit_entry_id, credit_entry_id, match_kind, status) VALUES (?, 'outlier-debit', 'outlier-credit', 'cross_currency', 'confirmed')", [randomUUID()]);
    await database.run("INSERT INTO category_assignments (id, ledger_entry_id, category_id, method, needs_review) VALUES (?, 'outlier-debit', 'personal-transfers', 'deterministic', 0)", [randomUUID()]);

    expect(await new AutomaticFxRepairService(database).run()).toEqual({ checked: 1, revoked: 1, retained: 0 });
    expect(await database.get<{ count: number }>("SELECT count(*) AS count FROM movement_groups")).toEqual({ count: 0 });
    expect(await database.get<{ count: number }>("SELECT count(*) AS count FROM fx_conversions")).toEqual({ count: 0 });
    expect(await database.get<{ count: number }>("SELECT count(*) AS count FROM cost_components")).toEqual({ count: 0 });
    expect(await database.all<{ kind: string; status: string }>("SELECT entry_kind AS kind, reconciliation_status AS status FROM ledger_entries ORDER BY id")).toEqual([
      { kind: "unclassified", status: "unlinked" },
      { kind: "unclassified", status: "unlinked" },
    ]);
    expect(await database.get<{ status: string }>("SELECT status FROM movement_candidates")).toEqual({ status: "rejected" });
    expect(await database.get<{ count: number }>("SELECT count(*) AS count FROM category_assignments")).toEqual({ count: 0 });
  });

  it("retains plausible heuristic FX and ignores hard-evidence groups", async () => {
    await addFxGroup("plausible", "automatic_fx", "0.0235", "0.024");
    await addFxGroup("hard", "same_source_record", "0.1", "0.024");

    expect(await new AutomaticFxRepairService(database).run()).toEqual({ checked: 1, revoked: 0, retained: 1 });
    expect(await database.get<{ count: number }>("SELECT count(*) AS count FROM movement_groups")).toEqual({ count: 2 });
  });
});

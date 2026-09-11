import { randomUUID } from "node:crypto";

import Decimal from "decimal.js";

import { currencyMinorDigits } from "@/domain/money";
import { parsePrivatFxDescription } from "@/domain/privat-fx-evidence";
import type { EncryptedDatabase } from "@/server/db/database";

interface ProceedsRow {
  id: string;
  amountMinor: string;
  currency: string;
  occurredAt: string;
  description: string | null;
  movementGroupId: string | null;
  evidenceKind: string | null;
}

function executedRate(input: {
  soldAmountMinor: bigint;
  soldCurrency: string;
  receivedAmountMinor: bigint;
  receivedCurrency: string;
}): Decimal {
  const soldMajor = new Decimal(input.soldAmountMinor.toString())
    .div(new Decimal(10).pow(currencyMinorDigits(input.soldCurrency)));
  const receivedMajor = new Decimal(input.receivedAmountMinor.toString())
    .div(new Decimal(10).pow(currencyMinorDigits(input.receivedCurrency)));
  return receivedMajor.div(soldMajor);
}

export class ProviderFxEvidenceService {
  readonly #database: EncryptedDatabase;

  constructor(database: EncryptedDatabase) {
    this.#database = database;
  }

  async run(): Promise<{ parsed: number; confirmed: number; invalid: number; revoked: number }> {
    const rows = await this.#rows();
    let parsed = 0;
    let confirmed = 0;
    let invalid = 0;
    let revoked = 0;

    for (const row of rows) {
      const evidence = parsePrivatFxDescription(row.description ?? "");
      if (!evidence) continue;
      parsed += 1;
      if (row.evidenceKind === "provider_fx_description") continue;
      if (evidence.soldCurrency === row.currency) {
        invalid += 1;
        continue;
      }
      const receivedAmountMinor = BigInt(row.amountMinor);
      const actualRate = executedRate({
        soldAmountMinor: evidence.soldAmountMinor,
        soldCurrency: evidence.soldCurrency,
        receivedAmountMinor,
        receivedCurrency: row.currency,
      });
      const deviation = actualRate.sub(evidence.statedRate).abs().div(evidence.statedRate);
      if (!actualRate.isFinite() || actualRate.lte(0) || deviation.gt(0.005)) {
        invalid += 1;
        continue;
      }
      if (row.movementGroupId && !["automatic_fx", "account_hint"].includes(row.evidenceKind ?? "")) {
        invalid += 1;
        continue;
      }

      await this.#database.transaction(async () => {
        if (row.movementGroupId) {
          await this.#revokeWeakerGroup(row.movementGroupId);
          revoked += 1;
        }
        await this.#database.run(
          "UPDATE transaction_evidence SET source_amount_minor = CAST(? AS INTEGER), source_currency = ? WHERE ledger_entry_id = ?",
          [evidence.soldAmountMinor.toString(), evidence.soldCurrency, row.id],
        );
        const groupId = randomUUID();
        await this.#database.run(
          "INSERT INTO movement_groups (id, status, evidence_kind, confirmed_at) VALUES (?, 'confirmed', 'provider_fx_description', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
          [groupId],
        );
        await this.#database.run(
          "INSERT INTO movement_legs (id, movement_group_id, ledger_entry_id, leg_kind, position) VALUES (?, ?, ?, 'fx_buy', 0)",
          [randomUUID(), groupId, row.id],
        );
        await this.#database.run(
          `INSERT INTO fx_conversions (
            id, movement_group_id, sold_amount_minor, sold_currency,
            received_amount_minor, received_currency, executed_rate_text, formula_version
          ) VALUES (?, ?, CAST(? AS INTEGER), ?, CAST(? AS INTEGER), ?, ?, 'provider-description@1')`,
          [
            randomUUID(),
            groupId,
            evidence.soldAmountMinor.toString(),
            evidence.soldCurrency,
            receivedAmountMinor.toString(),
            row.currency,
            actualRate.toSignificantDigits(24).toString(),
          ],
        );
        await this.#database.run(
          "UPDATE ledger_entries SET entry_kind = 'fx_buy', reconciliation_status = 'confirmed' WHERE id = ?",
          [row.id],
        );
        await this.#database.run(
          "INSERT INTO audit_events (id, event_code, entity_type, entity_id, safe_details_json) VALUES (?, 'PROVIDER_FX_EVIDENCE_CONFIRMED', 'movement_group', ?, ?)",
          [randomUUID(), groupId, JSON.stringify({ parserVersion: "provider-description@1", sourceCurrency: evidence.soldCurrency, destinationCurrency: row.currency })],
        );
        confirmed += 1;
      });
    }

    return { parsed, confirmed, invalid, revoked };
  }

  async #revokeWeakerGroup(groupId: string): Promise<void> {
    const legs = await this.#database.all<{ entryId: string }>(
      "SELECT ledger_entry_id AS entryId FROM movement_legs WHERE movement_group_id = ? ORDER BY position, rowid",
      [groupId],
    );
    for (const leg of legs) {
      await this.#database.run(
        "DELETE FROM category_assignments WHERE ledger_entry_id = ? AND method NOT IN ('manual', 'user_rule')",
        [leg.entryId],
      );
      await this.#database.run(
        "UPDATE movement_candidates SET status = 'rejected', reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE status = 'confirmed' AND (debit_entry_id = ? OR credit_entry_id = ?)",
        [leg.entryId, leg.entryId],
      );
    }
    await this.#database.run("DELETE FROM cost_components WHERE movement_group_id = ?", [groupId]);
    await this.#database.run("DELETE FROM fx_conversions WHERE movement_group_id = ?", [groupId]);
    await this.#database.run("DELETE FROM movement_legs WHERE movement_group_id = ?", [groupId]);
    for (const leg of legs) {
      await this.#database.run(
        "UPDATE ledger_entries SET entry_kind = 'unclassified', reconciliation_status = 'unlinked' WHERE id = ?",
        [leg.entryId],
      );
    }
    await this.#database.run("DELETE FROM movement_groups WHERE id = ?", [groupId]);
    await this.#database.run(
      "INSERT INTO audit_events (id, event_code, entity_type, entity_id, safe_details_json) VALUES (?, 'WEAKER_FX_LINK_REPLACED', 'movement_group', ?, ?)",
      [randomUUID(), groupId, JSON.stringify({ replacementEvidence: "provider_fx_description" })],
    );
  }

  async #rows(): Promise<ProceedsRow[]> {
    return this.#database.all<ProceedsRow>(`
      SELECT DISTINCT
        entry.id,
        CAST(entry.amount_minor AS TEXT) AS amountMinor,
        entry.currency,
        entry.occurred_at AS occurredAt,
        entry.private_description AS description,
        movement.id AS movementGroupId,
        movement.evidence_kind AS evidenceKind
      FROM ledger_entries entry
      JOIN accounts account ON account.id = entry.account_id
      JOIN transaction_evidence evidence ON evidence.ledger_entry_id = entry.id
      JOIN source_records source ON source.id = evidence.source_record_id
      JOIN import_batches batch ON batch.id = source.batch_id
      JOIN import_artifacts artifact ON artifact.id = batch.artifact_id
      LEFT JOIN movement_legs leg ON leg.ledger_entry_id = entry.id
      LEFT JOIN movement_groups movement ON movement.id = leg.movement_group_id
      WHERE artifact.parser_kind = 'privat_fop_journal'
        AND account.owner_scope = 'SOLE_PROPRIETOR'
        AND entry.direction = 'credit'
        AND entry.amount_minor > 0
      ORDER BY entry.occurred_at, entry.id
    `);
  }
}

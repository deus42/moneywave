import { randomUUID } from "node:crypto";

import { analyzeFxCost, analyzeSameCurrencyCost, type CostComponent } from "@/domain/cost-engine";
import { parseMinorUnits, sumMinor } from "@/domain/money";
import type { EncryptedDatabase } from "@/server/db/database";

interface GroupEntry {
  id: string;
  amountMinorText: string;
  currency: string;
  direction: "debit" | "credit";
  legKind: string;
}

export class CostService {
  readonly #database: EncryptedDatabase;

  constructor(database: EncryptedDatabase) {
    this.#database = database;
  }

  async reconcileSameCurrency(groupId: string, input: {
    manualCostsMajor: readonly string[];
    confirmResidualAsTransferGap: boolean;
  }): Promise<ReturnType<typeof analyzeSameCurrencyCost>> {
    const entries = await this.#loadGroup(groupId);
    const currencies = new Set(entries.map(({ currency }) => currency));
    if (currencies.size !== 1) throw new Error("COST_GROUP_NOT_SAME_CURRENCY");
    const currency = entries[0]?.currency;
    if (!currency) throw new Error("COST_GROUP_EMPTY");
    const explicitLegFees = entries
      .filter(({ legKind }) => legKind === "explicit_fee")
      .map(({ amountMinorText }) => {
        const value = BigInt(amountMinorText);
        return value < 0n ? -value : value;
      });
    const result = analyzeSameCurrencyCost({
      currency,
      sourceDebitsMinor: entries.filter(({ direction }) => direction === "debit").map(({ amountMinorText }) => BigInt(amountMinorText)),
      destinationCreditsMinor: entries.filter(({ direction }) => direction === "credit").map(({ amountMinorText }) => BigInt(amountMinorText)),
      explicitFeesMinor: explicitLegFees,
      manualCostsMinor: input.manualCostsMajor.map((value) => parseMinorUnits(value, currency)),
      confirmResidualAsTransferGap: input.confirmResidualAsTransferGap,
    });
    await this.#persistComponents(groupId, result.components, result.reconciled, "SAME_CURRENCY_COST_RECORDED");
    return result;
  }

  async reconcileFx(groupId: string, input: {
    benchmarkRate: string | null;
    benchmarkSource: string | null;
    publicationDate: string | null;
    manualCostMajor: string;
  }): Promise<ReturnType<typeof analyzeFxCost> & { reconciled: boolean }> {
    const entries = await this.#loadGroup(groupId);
    const explicitFeeEntries = entries.filter(({ legKind }) => legKind === "explicit_fee");
    const movementEntries = entries.filter(({ legKind }) => legKind !== "explicit_fee");
    const debits = movementEntries.filter(({ direction }) => direction === "debit");
    const credits = movementEntries.filter(({ direction }) => direction === "credit");
    const debit = debits[0];
    const credit = credits[0];
    if (!debit || !credit || debits.length !== 1 || credits.length !== 1) {
      throw new Error("FX_GROUP_LEGS_INVALID");
    }
    if (debit.currency === credit.currency) throw new Error("FX_GROUP_CURRENCIES_INVALID");
    if (explicitFeeEntries.some(({ currency }) => currency !== credit.currency)) throw new Error("FX_FEE_CURRENCY_INVALID");
    const soldMinor = BigInt(debit.amountMinorText);
    const explicitFeeMinor = sumMinor(explicitFeeEntries.map(({ amountMinorText }) => {
      const amount = BigInt(amountMinorText);
      return amount < 0n ? -amount : amount;
    }));
    const result = analyzeFxCost({
      sold: { amountMinor: soldMinor < 0n ? -soldMinor : soldMinor, currency: debit.currency },
      received: { amountMinor: BigInt(credit.amountMinorText), currency: credit.currency },
      benchmarkRate: input.benchmarkRate,
      benchmarkSource: input.benchmarkSource,
      publicationDate: input.publicationDate,
      explicitFeeMinor,
      manualCostMinor: parseMinorUnits(input.manualCostMajor, credit.currency),
    });
    const reconciled = !result.components.some(({ method }) => method === "unexplained_gap");
    await this.#ensureCostAnalysisAbsent(groupId);
    await this.#database.transaction(async () => {
      await this.#database.run(
        "INSERT INTO fx_conversions (id, movement_group_id, sold_amount_minor, sold_currency, received_amount_minor, received_currency, executed_rate_text, benchmark_rate_text, benchmark_source, benchmark_publication_date, formula_version) VALUES (?, ?, CAST(? AS INTEGER), ?, CAST(? AS INTEGER), ?, ?, ?, ?, ?, ?)",
        [randomUUID(), groupId, (soldMinor < 0n ? -soldMinor : soldMinor).toString(), debit.currency, credit.amountMinorText, credit.currency, result.executedRate, input.benchmarkRate, input.benchmarkSource, input.publicationDate, "fx-cost@1"],
      );
      await this.#insertComponents(groupId, result.components, {
        benchmarkSource: input.benchmarkSource,
        publicationDate: input.publicationDate,
        formula: result.auditEvidence.formula,
      });
      if (reconciled) await this.#database.run("UPDATE movement_groups SET status = 'reconciled' WHERE id = ?", [groupId]);
      await this.#database.run(
        "INSERT INTO audit_events (id, event_code, entity_type, entity_id, safe_details_json) VALUES (?, 'FX_COST_RECORDED', 'movement_group', ?, ?)",
        [randomUUID(), groupId, JSON.stringify({ benchmarkSource: input.benchmarkSource, publicationDate: input.publicationDate, formulaVersion: "fx-cost@1", reconciled })],
      );
    });
    return { ...result, reconciled };
  }

  async #persistComponents(groupId: string, components: readonly CostComponent[], reconciled: boolean, eventCode: string): Promise<void> {
    await this.#ensureCostAnalysisAbsent(groupId);
    await this.#database.transaction(async () => {
      await this.#insertComponents(groupId, components, { formulaVersion: "same-currency-cost@1" });
      if (reconciled) await this.#database.run("UPDATE movement_groups SET status = 'reconciled' WHERE id = ?", [groupId]);
      await this.#database.run(
        "INSERT INTO audit_events (id, event_code, entity_type, entity_id, safe_details_json) VALUES (?, ?, 'movement_group', ?, ?)",
        [randomUUID(), eventCode, groupId, JSON.stringify({ formulaVersion: "same-currency-cost@1", reconciled })],
      );
    });
  }

  async #insertComponents(groupId: string, components: readonly CostComponent[], auditEvidence: Record<string, unknown>): Promise<void> {
    for (const component of components) {
      await this.#database.run(
        "INSERT INTO cost_components (id, movement_group_id, method, amount_minor, currency, estimated, audit_evidence_json) VALUES (?, ?, ?, CAST(? AS INTEGER), ?, ?, ?)",
        [randomUUID(), groupId, component.method, component.amountMinor.toString(), component.currency, component.estimated ? 1 : 0, JSON.stringify(auditEvidence)],
      );
    }
  }

  async #ensureCostAnalysisAbsent(groupId: string): Promise<void> {
    const group = await this.#database.get<{ status: string }>("SELECT status FROM movement_groups WHERE id = ?", [groupId]);
    if (!group) throw new Error("MOVEMENT_GROUP_NOT_FOUND");
    const existing = await this.#database.get<{ present: number }>(
      "SELECT 1 AS present FROM cost_components WHERE movement_group_id = ? UNION SELECT 1 AS present FROM fx_conversions WHERE movement_group_id = ? LIMIT 1",
      [groupId, groupId],
    );
    if (existing) throw new Error("COST_ANALYSIS_ALREADY_EXISTS");
  }

  async #loadGroup(groupId: string): Promise<GroupEntry[]> {
    const group = await this.#database.get<{ status: string }>("SELECT status FROM movement_groups WHERE id = ?", [groupId]);
    if (!group) throw new Error("MOVEMENT_GROUP_NOT_FOUND");
    return this.#database.all<GroupEntry>(`
      SELECT
        le.id,
        CAST(le.amount_minor AS TEXT) AS amountMinorText,
        le.currency,
        le.direction,
        ml.leg_kind AS legKind
      FROM movement_legs ml
      JOIN ledger_entries le ON le.id = ml.ledger_entry_id
      WHERE ml.movement_group_id = ?
      ORDER BY ml.position
    `, [groupId]);
  }
}

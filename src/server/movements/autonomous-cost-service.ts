import { randomUUID } from "node:crypto";

import { analyzeFxCost } from "@/domain/cost-engine";
import type { OfficialFxRate } from "@/domain/fx-service";
import type { EncryptedDatabase } from "@/server/db/database";

interface BenchmarkResolver {
  benchmark(input: { base: string; quote: string; onOrBeforeDate: string }): Promise<OfficialFxRate>;
}

interface FxRow {
  id: string;
  groupId: string;
  soldAmountMinor: string;
  soldCurrency: string;
  receivedAmountMinor: string;
  receivedCurrency: string;
  occurredDate: string;
}

export interface AutonomousCostResult {
  exactGroupsReconciled: number;
  providerFeesRecorded: number;
  fxBenchmarked: number;
  fxBenchmarkUnavailable: number;
}

export class AutonomousCostService {
  readonly #database: EncryptedDatabase;
  readonly #rates: BenchmarkResolver;

  constructor(database: EncryptedDatabase, rates: BenchmarkResolver) {
    this.#database = database;
    this.#rates = rates;
  }

  async run(): Promise<AutonomousCostResult> {
    const providerFeesRecorded = await this.#recordProviderFees();
    const exactGroupIds = await this.#exactUncostedGroups();
    let exactGroupsReconciled = 0;
    for (const groupId of exactGroupIds) {
      const updated = await this.#database.run(
        "UPDATE movement_groups SET status = 'reconciled' WHERE id = ? AND status = 'confirmed'",
        [groupId],
      );
      if (updated.changes !== 1) continue;
      exactGroupsReconciled += 1;
      await this.#database.run(
        "INSERT INTO audit_events (id, event_code, entity_type, entity_id, safe_details_json) VALUES (?, 'EXACT_MOVEMENT_RECONCILED', 'movement_group', ?, ?)",
        [randomUUID(), groupId, JSON.stringify({ formulaVersion: "same_currency_exact_v1" })],
      );
    }

    const pendingFx = await this.#pendingFx();
    let fxBenchmarked = 0;
    let fxBenchmarkUnavailable = 0;
    for (const conversion of pendingFx) {
      let benchmark: OfficialFxRate;
      try {
        benchmark = await this.#rates.benchmark({
          base: conversion.soldCurrency,
          quote: conversion.receivedCurrency,
          onOrBeforeDate: conversion.occurredDate,
        });
      } catch {
        fxBenchmarkUnavailable += 1;
        continue;
      }
      const result = analyzeFxCost({
        sold: { amountMinor: BigInt(conversion.soldAmountMinor), currency: conversion.soldCurrency },
        received: { amountMinor: BigInt(conversion.receivedAmountMinor), currency: conversion.receivedCurrency },
        benchmarkRate: benchmark.rate,
        benchmarkSource: benchmark.source,
        publicationDate: benchmark.publicationDate,
        explicitFeeMinor: 0n,
      });
      const reconciled = !result.components.some(({ method }) => method === "unexplained_gap");
      await this.#database.transaction(async () => {
        const updated = await this.#database.run(
          `UPDATE fx_conversions
           SET executed_rate_text = ?, benchmark_rate_text = ?, benchmark_source = ?,
               benchmark_publication_date = ?, formula_version = 'fx-cost@1'
           WHERE id = ? AND benchmark_source IS NULL`,
          [result.executedRate, benchmark.rate, benchmark.source, benchmark.publicationDate, conversion.id],
        );
        if (updated.changes !== 1) return;
        for (const component of result.components) {
          await this.#database.run(
            "INSERT INTO cost_components (id, movement_group_id, method, amount_minor, currency, estimated, audit_evidence_json) VALUES (?, ?, ?, CAST(? AS INTEGER), ?, ?, ?)",
            [
              randomUUID(),
              conversion.groupId,
              component.method,
              component.amountMinor.toString(),
              component.currency,
              component.estimated ? 1 : 0,
              JSON.stringify({
                benchmarkSource: benchmark.source,
                publicationDate: benchmark.publicationDate,
                formula: result.auditEvidence.formula,
              }),
            ],
          );
        }
        if (reconciled) {
          await this.#database.run("UPDATE movement_groups SET status = 'reconciled' WHERE id = ?", [conversion.groupId]);
        }
        await this.#database.run(
          "INSERT INTO audit_events (id, event_code, entity_type, entity_id, safe_details_json) VALUES (?, 'FX_COST_AUTOMATICALLY_RECORDED', 'movement_group', ?, ?)",
          [randomUUID(), conversion.groupId, JSON.stringify({ benchmarkSource: benchmark.source, formulaVersion: "fx-cost@1", reconciled })],
        );
        fxBenchmarked += 1;
      });
    }
    return { exactGroupsReconciled, providerFeesRecorded, fxBenchmarked, fxBenchmarkUnavailable };
  }

  async #recordProviderFees(): Promise<number> {
    const groups = await this.#database.all<{
      groupId: string;
      currency: string;
      debitMinorText: string;
      creditMinorText: string;
    }>(`
      SELECT
        movement.id AS groupId,
        MIN(entry.currency) AS currency,
        CAST(MIN(CASE WHEN entry.direction = 'debit' THEN entry.amount_minor END) AS TEXT) AS debitMinorText,
        CAST(MAX(CASE WHEN entry.direction = 'credit' THEN entry.amount_minor END) AS TEXT) AS creditMinorText
      FROM movement_groups movement
      JOIN movement_legs leg ON leg.movement_group_id = movement.id
      JOIN ledger_entries entry ON entry.id = leg.ledger_entry_id
      WHERE movement.status = 'confirmed'
        AND NOT EXISTS (SELECT 1 FROM fx_conversions fx WHERE fx.movement_group_id = movement.id)
        AND NOT EXISTS (
          SELECT 1 FROM cost_components cost
          WHERE cost.movement_group_id = movement.id AND cost.method = 'explicit_statement_fee'
        )
      GROUP BY movement.id
      HAVING COUNT(*) = 2
        AND COUNT(DISTINCT entry.currency) = 1
        AND SUM(CASE WHEN entry.direction = 'debit' THEN 1 ELSE 0 END) = 1
        AND SUM(CASE WHEN entry.direction = 'credit' THEN 1 ELSE 0 END) = 1
      ORDER BY movement.id
    `);
    let recorded = 0;
    for (const group of groups) {
      const fees = await this.#database.all<{ entryId: string; minimum: string; maximum: string; currencyCount: number; currency: string }>(`
        SELECT
          entry.id AS entryId,
          CAST(MIN(fee.amount_minor) AS TEXT) AS minimum,
          CAST(MAX(fee.amount_minor) AS TEXT) AS maximum,
          COUNT(DISTINCT fee.currency) AS currencyCount,
          MIN(fee.currency) AS currency
        FROM movement_legs leg
        JOIN ledger_entries entry ON entry.id = leg.ledger_entry_id
        JOIN transaction_evidence evidence ON evidence.ledger_entry_id = entry.id
        JOIN provider_fee_evidence fee ON fee.transaction_evidence_id = evidence.id
        WHERE leg.movement_group_id = ?
        GROUP BY entry.id
        ORDER BY entry.id
      `, [group.groupId]);
      if (
        fees.length === 0
        || fees.some((fee) => fee.minimum !== fee.maximum || fee.currencyCount !== 1 || fee.currency !== group.currency)
      ) continue;
      const feeMinor = fees.reduce((sum, fee) => sum + BigInt(fee.maximum), 0n);
      const debit = -BigInt(group.debitMinorText);
      const credit = BigInt(group.creditMinorText);
      if (feeMinor <= 0n || debit !== credit + feeMinor) continue;
      await this.#database.transaction(async () => {
        await this.#database.run(
          "DELETE FROM cost_components WHERE movement_group_id = ? AND method = 'unexplained_gap' AND amount_minor = CAST(? AS INTEGER)",
          [group.groupId, feeMinor.toString()],
        );
        const inserted = await this.#database.run(`
          INSERT INTO cost_components (id, movement_group_id, method, amount_minor, currency, estimated, audit_evidence_json)
          SELECT ?, ?, 'explicit_statement_fee', CAST(? AS INTEGER), ?, 0, ?
          WHERE NOT EXISTS (
            SELECT 1 FROM cost_components WHERE movement_group_id = ? AND method = 'explicit_statement_fee'
          )
        `, [
          randomUUID(),
          group.groupId,
          feeMinor.toString(),
          group.currency,
          JSON.stringify({ formulaVersion: "provider_fee_composition_v1", includedInSettlement: true }),
          group.groupId,
        ]);
        if (inserted.changes !== 1) return;
        await this.#database.run("UPDATE movement_groups SET status = 'reconciled' WHERE id = ?", [group.groupId]);
        await this.#database.run(
          "INSERT INTO audit_events (id, event_code, entity_type, entity_id, safe_details_json) VALUES (?, 'PROVIDER_FEE_RECONCILED', 'movement_group', ?, ?)",
          [randomUUID(), group.groupId, JSON.stringify({ formulaVersion: "provider_fee_composition_v1" })],
        );
        recorded += 1;
      });
    }
    return recorded;
  }

  async #exactUncostedGroups(): Promise<string[]> {
    const rows = await this.#database.all<{ id: string }>(`
      SELECT movement.id
      FROM movement_groups movement
      JOIN movement_legs leg ON leg.movement_group_id = movement.id
      JOIN ledger_entries entry ON entry.id = leg.ledger_entry_id
      WHERE movement.status = 'confirmed'
        AND NOT EXISTS (SELECT 1 FROM cost_components cost WHERE cost.movement_group_id = movement.id)
        AND NOT EXISTS (SELECT 1 FROM fx_conversions fx WHERE fx.movement_group_id = movement.id)
      GROUP BY movement.id
      HAVING COUNT(*) = 2
        AND COUNT(DISTINCT entry.currency) = 1
        AND SUM(CASE WHEN entry.direction = 'debit' THEN 1 ELSE 0 END) = 1
        AND SUM(CASE WHEN entry.direction = 'credit' THEN 1 ELSE 0 END) = 1
        AND SUM(entry.amount_minor) = 0
      ORDER BY movement.id
    `);
    return rows.map(({ id }) => id);
  }

  async #pendingFx(): Promise<FxRow[]> {
    return this.#database.all<FxRow>(`
      SELECT
        fx.id,
        fx.movement_group_id AS groupId,
        CAST(fx.sold_amount_minor AS TEXT) AS soldAmountMinor,
        fx.sold_currency AS soldCurrency,
        CAST(fx.received_amount_minor AS TEXT) AS receivedAmountMinor,
        fx.received_currency AS receivedCurrency,
        substr(MIN(entry.occurred_at), 1, 10) AS occurredDate
      FROM fx_conversions fx
      JOIN movement_legs leg ON leg.movement_group_id = fx.movement_group_id
      JOIN ledger_entries entry ON entry.id = leg.ledger_entry_id
      WHERE fx.benchmark_source IS NULL
        AND NOT EXISTS (SELECT 1 FROM cost_components cost WHERE cost.movement_group_id = fx.movement_group_id)
      GROUP BY fx.id
      HAVING occurredDate IS NOT NULL
      ORDER BY fx.id
    `);
  }
}

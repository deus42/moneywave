import Decimal from "decimal.js";

import { currencyMinorDigits, requireInt64 } from "@/domain/money";
import type { EncryptedDatabase } from "@/server/db/database";
import type { ResolvedHistoricalRate } from "./historical-rates";

const FORMULA_VERSION = "official-daily-v1";
const DEFAULT_TARGETS = ["UAH", "EUR", "USD"] as const;

export interface ReportingRateResolver {
  resolve(
    base: string,
    quote: string,
    requestedDate: string,
  ): ResolvedHistoricalRate | null | Promise<ResolvedHistoricalRate | null>;
}

interface ValuationSourceRow {
  id: string;
  amountMinorText: string;
  currency: string;
  requestedDate: string;
}

interface PreparedValuation extends ValuationSourceRow {
  targetCurrency: string;
  convertedAmountMinor: bigint;
  rate: ResolvedHistoricalRate;
}

export interface MissingValuationRate {
  entityType: "balance_snapshot" | "cost_component" | "fx_conversion" | "ledger_entry";
  sourceCurrency: string;
  targetCurrency: string;
  requestedDate: string;
}

function normalizeDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || Number.isNaN(new Date(`${value}T00:00:00Z`).getTime())) {
    throw new Error("FX_DATE_INVALID");
  }
  return value;
}

function normalizeTargets(values: readonly string[]): string[] {
  const targets = [...new Set(values.map((value) => value.trim().toUpperCase()))].sort();
  if (targets.length === 0 || targets.some((value) => !/^[A-Z]{3,8}$/u.test(value))) throw new Error("FX_TARGET_INVALID");
  for (const target of targets) currencyMinorDigits(target);
  return targets;
}

function convertMinorUnits(amountMinorText: string, sourceCurrency: string, targetCurrency: string, rateText: string): bigint {
  const amount = new Decimal(amountMinorText);
  const rate = new Decimal(rateText);
  if (!amount.isInteger() || !rate.isFinite() || !rate.gt(0)) throw new Error("FX_RATE_INVALID");
  const sourceScale = new Decimal(10).pow(currencyMinorDigits(sourceCurrency));
  const targetScale = new Decimal(10).pow(currencyMinorDigits(targetCurrency));
  const converted = amount.div(sourceScale).mul(rate).mul(targetScale).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  return requireInt64(BigInt(converted.toFixed(0)));
}

async function prepare(
  rows: readonly ValuationSourceRow[],
  entityType: MissingValuationRate["entityType"],
  targets: readonly string[],
  resolver: ReportingRateResolver,
): Promise<{ valuations: PreparedValuation[]; missing: MissingValuationRate[] }> {
  const valuations: PreparedValuation[] = [];
  const missing: MissingValuationRate[] = [];
  for (const row of rows) {
    currencyMinorDigits(row.currency);
    for (const targetCurrency of targets) {
      const rate = await resolver.resolve(row.currency, targetCurrency, row.requestedDate);
      if (!rate) {
        missing.push({ entityType, sourceCurrency: row.currency, targetCurrency, requestedDate: row.requestedDate });
        continue;
      }
      valuations.push({
        ...row,
        targetCurrency,
        convertedAmountMinor: convertMinorUnits(row.amountMinorText, row.currency, targetCurrency, rate.rate),
        rate,
      });
    }
  }
  return { valuations, missing };
}

export class ValuationService {
  readonly #database: EncryptedDatabase;
  readonly #resolver: ReportingRateResolver;

  constructor(database: EncryptedDatabase, resolver: ReportingRateResolver) {
    this.#database = database;
    this.#resolver = resolver;
  }

  async materialize(input: {
    fromDate: string;
    toDate: string;
    targetCurrencies?: readonly string[];
  }): Promise<{ entryValuations: number; balanceValuations: number; costValuations: number; fxSourceValuations: number; missingRates: MissingValuationRate[] }> {
    const fromDate = normalizeDate(input.fromDate);
    const toDate = normalizeDate(input.toDate);
    if (fromDate > toDate) throw new Error("FX_DATE_RANGE_INVALID");
    const targets = normalizeTargets(input.targetCurrencies ?? DEFAULT_TARGETS);
    const entries = await this.#database.all<ValuationSourceRow>(`
      SELECT id, CAST(amount_minor AS TEXT) AS amountMinorText, currency, substr(occurred_at, 1, 10) AS requestedDate
      FROM ledger_entries
      WHERE substr(occurred_at, 1, 10) BETWEEN ? AND ?
      ORDER BY occurred_at, id
    `, [fromDate, toDate]);
    const balances = await this.#database.all<ValuationSourceRow>(`
      SELECT id, CAST(balance_minor AS TEXT) AS amountMinorText, currency, substr(observed_at, 1, 10) AS requestedDate
      FROM balance_snapshots
      WHERE substr(observed_at, 1, 10) BETWEEN ? AND ?
      ORDER BY observed_at, id
    `, [fromDate, toDate]);
    const costs = await this.#database.all<ValuationSourceRow>(`
      SELECT component.id, CAST(component.amount_minor AS TEXT) AS amountMinorText, component.currency,
        substr(MIN(entry.occurred_at), 1, 10) AS requestedDate
      FROM cost_components component
      JOIN movement_legs leg ON leg.movement_group_id = component.movement_group_id
      JOIN ledger_entries entry ON entry.id = leg.ledger_entry_id
      GROUP BY component.id, component.amount_minor, component.currency
      HAVING requestedDate BETWEEN ? AND ?
      ORDER BY requestedDate, component.id
    `, [fromDate, toDate]);
    const fxSources = await this.#database.all<ValuationSourceRow>(`
      SELECT conversion.id, CAST(conversion.sold_amount_minor AS TEXT) AS amountMinorText,
        conversion.sold_currency AS currency, substr(MIN(entry.occurred_at), 1, 10) AS requestedDate
      FROM fx_conversions conversion
      JOIN movement_legs leg ON leg.movement_group_id = conversion.movement_group_id
      JOIN ledger_entries entry ON entry.id = leg.ledger_entry_id
      GROUP BY conversion.id, conversion.sold_amount_minor, conversion.sold_currency
      HAVING requestedDate BETWEEN ? AND ?
      ORDER BY requestedDate, conversion.id
    `, [fromDate, toDate]);
    const [entryPrepared, balancePrepared, costPrepared, fxSourcePrepared] = await Promise.all([
      prepare(entries, "ledger_entry", targets, this.#resolver),
      prepare(balances, "balance_snapshot", targets, this.#resolver),
      prepare(costs, "cost_component", targets, this.#resolver),
      prepare(fxSources, "fx_conversion", targets, this.#resolver),
    ]);

    await this.#database.transaction(async () => {
      for (const row of entries) {
        for (const target of targets) {
          await this.#database.run(
            "DELETE FROM ledger_entry_valuations WHERE ledger_entry_id = ? AND target_currency = ?",
            [row.id, target],
          );
        }
      }
      for (const valuation of entryPrepared.valuations) {
        await this.#database.run(`
          INSERT INTO ledger_entry_valuations (
            ledger_entry_id, source_currency, target_currency, converted_amount_minor,
            requested_date, rate_text, source, publication_date, formula_version
          ) VALUES (?, ?, ?, CAST(? AS INTEGER), ?, ?, ?, ?, ?)
        `, [
          valuation.id,
          valuation.currency,
          valuation.targetCurrency,
          valuation.convertedAmountMinor.toString(),
          valuation.requestedDate,
          valuation.rate.rate,
          valuation.rate.source,
          valuation.rate.publicationDate,
          FORMULA_VERSION,
        ]);
      }
      for (const row of balances) {
        for (const target of targets) {
          await this.#database.run(
            "DELETE FROM balance_snapshot_valuations WHERE balance_snapshot_id = ? AND target_currency = ?",
            [row.id, target],
          );
        }
      }
      for (const valuation of balancePrepared.valuations) {
        await this.#database.run(`
          INSERT INTO balance_snapshot_valuations (
            balance_snapshot_id, source_currency, target_currency, converted_amount_minor,
            requested_date, rate_text, source, publication_date, formula_version
          ) VALUES (?, ?, ?, CAST(? AS INTEGER), ?, ?, ?, ?, ?)
        `, [
          valuation.id,
          valuation.currency,
          valuation.targetCurrency,
          valuation.convertedAmountMinor.toString(),
          valuation.requestedDate,
          valuation.rate.rate,
          valuation.rate.source,
          valuation.rate.publicationDate,
          FORMULA_VERSION,
        ]);
      }
      for (const row of costs) {
        for (const target of targets) {
          await this.#database.run(
            "DELETE FROM cost_component_valuations WHERE cost_component_id = ? AND target_currency = ?",
            [row.id, target],
          );
        }
      }
      for (const valuation of costPrepared.valuations) {
        await this.#database.run(`
          INSERT INTO cost_component_valuations (
            cost_component_id, source_currency, target_currency, converted_amount_minor,
            requested_date, rate_text, source, publication_date, formula_version
          ) VALUES (?, ?, ?, CAST(? AS INTEGER), ?, ?, ?, ?, ?)
        `, [
          valuation.id,
          valuation.currency,
          valuation.targetCurrency,
          valuation.convertedAmountMinor.toString(),
          valuation.requestedDate,
          valuation.rate.rate,
          valuation.rate.source,
          valuation.rate.publicationDate,
          FORMULA_VERSION,
        ]);
      }
      for (const row of fxSources) {
        for (const target of targets) {
          await this.#database.run(
            "DELETE FROM fx_conversion_source_valuations WHERE fx_conversion_id = ? AND target_currency = ?",
            [row.id, target],
          );
        }
      }
      for (const valuation of fxSourcePrepared.valuations) {
        await this.#database.run(`
          INSERT INTO fx_conversion_source_valuations (
            fx_conversion_id, source_currency, target_currency, converted_amount_minor,
            requested_date, rate_text, source, publication_date, formula_version
          ) VALUES (?, ?, ?, CAST(? AS INTEGER), ?, ?, ?, ?, ?)
        `, [
          valuation.id,
          valuation.currency,
          valuation.targetCurrency,
          valuation.convertedAmountMinor.toString(),
          valuation.requestedDate,
          valuation.rate.rate,
          valuation.rate.source,
          valuation.rate.publicationDate,
          FORMULA_VERSION,
        ]);
      }
    });

    const missingRates = [...entryPrepared.missing, ...balancePrepared.missing, ...costPrepared.missing, ...fxSourcePrepared.missing].sort((left, right) =>
      left.entityType.localeCompare(right.entityType)
      || left.sourceCurrency.localeCompare(right.sourceCurrency)
      || left.targetCurrency.localeCompare(right.targetCurrency)
      || left.requestedDate.localeCompare(right.requestedDate));
    return {
      entryValuations: entryPrepared.valuations.length,
      balanceValuations: balancePrepared.valuations.length,
      costValuations: costPrepared.valuations.length,
      fxSourceValuations: fxSourcePrepared.valuations.length,
      missingRates,
    };
  }
}

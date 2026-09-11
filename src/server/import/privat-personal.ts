import { hmacIdentifier, maskIdentifier } from "@/domain/privacy";
import { parseMinorUnits, sumMinor } from "@/domain/money";
import type {
  NormalizationResult,
  NormalizedSourceRow,
  OwnershipContext,
  ProbeResult,
  ReconciliationSummary,
  SourceRowState,
  StatementAdapter,
} from "./types";
import { cellValue, indexHeaders, parseBankDate, readWorkbookTable, stableDigest, textValue } from "./workbook";

const HEADERS = [
  "Дата",
  "Категорія",
  "Картка",
  "Опис операції",
  "Сума в валюті картки",
  "Валюта картки",
  "Сума в валюті транзакції",
  "Валюта транзакції",
  "Залишок на кінець періоду",
  "Валюта залишку",
] as const;

interface ParsedPersonalRow {
  sourceRowNumber: number;
  hasFormula: boolean;
  occurredAt: string | null;
  category: string;
  instrument: string;
  description: string;
  cardAmount: unknown;
  cardCurrency: string;
  transactionAmount: unknown;
  transactionCurrency: string;
  resultingBalance: unknown;
  balanceCurrency: string;
}

export interface ParsedPersonalStatement {
  rows: ParsedPersonalRow[];
}

export interface DiscoveredInstrument {
  identifierHash: string;
  display: string;
  currencies: string[];
}

function emptyStateCounts(): Record<SourceRowState, number> {
  return { posted: 0, non_posted: 0, unresolved: 0, rejected: 0 };
}

export class PrivatPersonalStatementAdapter implements StatementAdapter<ParsedPersonalStatement> {
  readonly #identifierKey: Buffer;

  constructor({ identifierKey }: { identifierKey: Buffer }) {
    this.#identifierKey = identifierKey;
  }

  probe(input: Buffer): ProbeResult {
    try {
      readWorkbookTable(input, HEADERS);
      return { matched: true, kind: "privat_personal" };
    } catch {
      return { matched: false, reasonCode: "FORMAT_UNSUPPORTED" };
    }
  }

  parse(input: Buffer): ParsedPersonalStatement {
    const table = readWorkbookTable(input, HEADERS);
    const indices = indexHeaders(table.headers);
    return {
      rows: table.rows.map(({ sourceRowNumber, values, hasFormula }) => ({
        sourceRowNumber,
        hasFormula,
        occurredAt: parseBankDate(cellValue(values, indices, "Дата")),
        category: textValue(cellValue(values, indices, "Категорія")),
        instrument: textValue(cellValue(values, indices, "Картка")),
        description: textValue(cellValue(values, indices, "Опис операції")),
        cardAmount: cellValue(values, indices, "Сума в валюті картки"),
        cardCurrency: textValue(cellValue(values, indices, "Валюта картки")).toUpperCase(),
        transactionAmount: cellValue(values, indices, "Сума в валюті транзакції"),
        transactionCurrency: textValue(cellValue(values, indices, "Валюта транзакції")).toUpperCase(),
        resultingBalance: cellValue(values, indices, "Залишок на кінець періоду"),
        balanceCurrency: textValue(cellValue(values, indices, "Валюта залишку")).toUpperCase(),
      })),
    };
  }

  discoverInstruments(parsed: ParsedPersonalStatement): DiscoveredInstrument[] {
    const discovered = new Map<string, DiscoveredInstrument>();
    for (const row of parsed.rows) {
      if (!row.instrument) continue;
      const identifierHash = hmacIdentifier(row.instrument, this.#identifierKey);
      const existing = discovered.get(identifierHash);
      const currencies = new Set(existing?.currencies ?? []);
      if (row.cardCurrency) currencies.add(row.cardCurrency);
      discovered.set(identifierHash, { identifierHash, display: maskIdentifier(row.instrument), currencies: [...currencies].sort() });
    }
    return [...discovered.values()].sort((left, right) => left.display.localeCompare(right.display));
  }

  normalize(parsed: ParsedPersonalStatement, context: OwnershipContext): NormalizationResult {
    return {
      kind: "privat_personal",
      rows: parsed.rows.map((row): NormalizedSourceRow => {
        const rawIdentity = [row.occurredAt, row.instrument, row.cardAmount, row.cardCurrency, row.transactionAmount, row.transactionCurrency, row.resultingBalance, row.balanceCurrency, row.description];
        const sourceRecordId = stableDigest([row.sourceRowNumber, ...rawIdentity]);
        const dedupeFingerprint = stableDigest(rawIdentity);
        const base = {
          sourceRowNumber: row.sourceRowNumber,
          sourceRecordId,
          dedupeFingerprint,
          observations: [],
          sourceMetadata: { sourceCategory: row.category || null },
        } satisfies Omit<NormalizedSourceRow, "state">;
        if (row.hasFormula) {
          return { ...base, state: "rejected", reasonCode: "FORMULA_NOT_ALLOWED" };
        }
        if (!row.instrument) {
          return { ...base, state: "rejected", reasonCode: "INSTRUMENT_MISSING" };
        }
        if (!row.occurredAt) {
          return { ...base, state: "unresolved", reasonCode: "TRANSACTION_DATE_MISSING" };
        }

        const ownIdentifierHash = hmacIdentifier(row.instrument, this.#identifierKey);
        const target = context.ownership.get(ownIdentifierHash);
        if (!target) {
          return {
            ...base,
            state: "unresolved",
            reasonCode: context.mappingComplete ? "INSTRUMENT_NOT_OWNED" : "OWNERSHIP_MAPPING_REQUIRED",
          };
        }

        try {
          const amountMinor = parseMinorUnits(row.cardAmount as string | number, row.cardCurrency);
          const sourceAmountMinor = parseMinorUnits(row.transactionAmount as string | number, row.transactionCurrency);
          const resultingBalanceMinor = parseMinorUnits(row.resultingBalance as string | number, row.balanceCurrency);
          if (row.cardCurrency !== row.balanceCurrency) {
            return { ...base, state: "rejected", reasonCode: "BALANCE_CURRENCY_CONFLICT" };
          }
          const direction = amountMinor >= 0n ? "credit" : "debit";
          return {
            ...base,
            state: "posted",
            direction,
            observations: [{
              id: stableDigest([sourceRecordId, target.accountId, direction]),
              sourceRecordId,
              provider: "privatbank",
              accountId: target.accountId,
              instrumentId: target.instrumentId,
              ownerScope: target.ownerScope,
              direction,
              amountMinor,
              currency: row.cardCurrency,
              sourceAmountMinor,
              sourceCurrency: row.transactionCurrency,
              resultingBalanceMinor,
              resultingBalanceCurrency: row.balanceCurrency,
              occurredAt: row.occurredAt,
              ownIdentifierHash,
              description: row.description,
              sourceCategory: row.category,
            }],
          };
        } catch (error) {
          const reasonCode = error instanceof Error ? error.message : "ROW_INVALID";
          return { ...base, state: "rejected", reasonCode };
        }
      }),
    };
  }

  reconcile(normalized: NormalizationResult): ReconciliationSummary & {
    balanceChecks: { checked: number; failed: number };
    totals: Array<{ currency: string; creditMinor: bigint; debitMinor: bigint }>;
  } {
    const stateCounts = emptyStateCounts();
    for (const row of normalized.rows) stateCounts[row.state] += 1;
    const groups = new Map<string, typeof normalized.rows[number]["observations"]>();
    for (const row of normalized.rows) {
      for (const observation of row.observations) {
        const key = `${observation.ownIdentifierHash}:${observation.currency}`;
        const list = groups.get(key) ?? [];
        list.push(observation);
        groups.set(key, list);
      }
    }
    let checked = 0;
    let failed = 0;
    for (const observations of groups.values()) {
      observations.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
      const statedBalances = observations
        .flatMap(({ resultingBalanceMinor }) => resultingBalanceMinor === undefined ? [] : [resultingBalanceMinor.toString()]);
      const isRepeatedPeriodEndBalance = statedBalances.length > 1 && new Set(statedBalances).size === 1;
      if (isRepeatedPeriodEndBalance) continue;
      for (let index = 1; index < observations.length; index += 1) {
        const previous = observations[index - 1];
        const current = observations[index];
        if (previous?.resultingBalanceMinor === undefined || current?.resultingBalanceMinor === undefined) continue;
        checked += 1;
        if (previous.resultingBalanceMinor + current.amountMinor !== current.resultingBalanceMinor) failed += 1;
      }
    }
    const totalsByCurrency = new Map<string, { credit: bigint[]; debit: bigint[] }>();
    for (const observations of groups.values()) {
      for (const observation of observations) {
        const totals = totalsByCurrency.get(observation.currency) ?? { credit: [], debit: [] };
        if (observation.amountMinor >= 0n) totals.credit.push(observation.amountMinor);
        else totals.debit.push(-observation.amountMinor);
        totalsByCurrency.set(observation.currency, totals);
      }
    }
    return {
      rowCount: normalized.rows.length,
      coveredRowCount: normalized.rows.length,
      silentlySkippedRowCount: 0,
      stateCounts,
      issues: failed > 0 ? ["BALANCE_DISCONTINUITY"] : [],
      balanceChecks: { checked, failed },
      totals: [...totalsByCurrency.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, totals]) => ({
        currency,
        creditMinor: sumMinor(totals.credit),
        debitMinor: sumMinor(totals.debit),
      })),
    };
  }
}

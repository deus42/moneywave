import Decimal from "decimal.js";

import { parseMinorUnits, sumMinor } from "@/domain/money";
import { hmacIdentifier, maskIdentifier } from "@/domain/privacy";
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

const REQUIRED_HEADERS = ["Деталі операції", "MCC", "Валюта", "Курс", "Залишок після операції"] as const;

interface ParsedMonobankRow {
  sourceRowNumber: number;
  hasFormula: boolean;
  occurredAt: string | null;
  description: string;
  mcc: string;
  cardAmount: unknown;
  cardCurrency: string;
  transactionAmount: unknown;
  transactionCurrency: string;
  providerRate: string | null;
  feeAmount: unknown;
  feeCurrency: string;
  cashbackAmount: unknown;
  cashbackCurrency: string;
  resultingBalance: unknown;
}

export interface ParsedMonobankStatement {
  accountIdentifier: string;
  instrumentIdentifier: string;
  cardCurrency: string;
  rows: ParsedMonobankRow[];
}

export interface DiscoveredMonobankAccount {
  identifierHash: string;
  display: string;
  currencies: string[];
  instrumentIdentifierHash: string;
  instrumentDisplay: string;
}

function emptyStateCounts(): Record<SourceRowState, number> {
  return { posted: 0, non_posted: 0, unresolved: 0, rejected: 0 };
}

function headerByPrefix(headers: readonly string[], prefix: string): string {
  const header = headers.find((candidate) => candidate.startsWith(prefix));
  if (!header) throw new Error("WORKBOOK_HEADERS_UNSUPPORTED");
  return header;
}

function currencyFromHeader(header: string): string {
  const match = header.match(/\(([A-Za-z]{3,8})\)\s*$/u);
  if (!match) throw new Error("WORKBOOK_HEADERS_UNSUPPORTED");
  return match[1]!.toUpperCase();
}

function metadataValue(preamble: readonly unknown[][], label: string): string {
  for (const row of preamble) {
    const values = row.map(textValue).filter(Boolean);
    const sameCell = values.find((value) => value.startsWith(label));
    if (sameCell) {
      const value = sameCell.slice(label.length).trim();
      if (value) return value;
    }
    const labelIndex = values.indexOf(label);
    if (labelIndex >= 0 && values[labelIndex + 1]) return values[labelIndex + 1]!;
  }
  return "";
}

function normalizeMcc(value: unknown): string {
  const text = textValue(value).replace(/\.0+$/u, "");
  if (!/^\d{1,4}$/u.test(text)) return "";
  return text.padStart(4, "0");
}

function normalizeRate(value: unknown): string | null {
  const text = textValue(value).replace(/[\s\u00a0]/gu, "").replace(",", ".");
  if (!text) return null;
  try {
    const rate = new Decimal(text);
    return rate.isFinite() && rate.gt(0) ? rate.toSignificantDigits(20).toString() : null;
  } catch {
    return null;
  }
}

function optionalMoneyInput(value: unknown): string | number {
  const text = textValue(value).replace(/[\s\u00a0]/gu, "");
  return !text || /^[-\u2013\u2014]+$/u.test(text) ? 0 : value as string | number;
}

function linkedInstrumentIdentity(accountIdentifier: string, instrumentIdentifier: string): string {
  return `${accountIdentifier}:${instrumentIdentifier}`;
}

export class MonobankStatementAdapter implements StatementAdapter<ParsedMonobankStatement> {
  readonly #identifierKey: Buffer;

  constructor({ identifierKey }: { identifierKey: Buffer }) {
    this.#identifierKey = identifierKey;
  }

  probe(input: Buffer): ProbeResult {
    try {
      const table = readWorkbookTable(input, REQUIRED_HEADERS);
      headerByPrefix(table.headers, "Дата");
      headerByPrefix(table.headers, "Сума в валюті картки");
      headerByPrefix(table.headers, "Сума в валюті операції");
      headerByPrefix(table.headers, "Сума комісій");
      headerByPrefix(table.headers, "Сума кешбеку");
      if (!metadataValue(table.preamble, "Рахунок:") || !metadataValue(table.preamble, "Інформація по картці:")) {
        throw new Error("MONOBANK_METADATA_MISSING");
      }
      return { matched: true, kind: "monobank_personal" };
    } catch {
      return { matched: false, reasonCode: "FORMAT_UNSUPPORTED" };
    }
  }

  parse(input: Buffer): ParsedMonobankStatement {
    const table = readWorkbookTable(input, REQUIRED_HEADERS);
    const dateHeader = headerByPrefix(table.headers, "Дата");
    const cardAmountHeader = headerByPrefix(table.headers, "Сума в валюті картки");
    const transactionAmountHeader = headerByPrefix(table.headers, "Сума в валюті операції");
    const feeHeader = headerByPrefix(table.headers, "Сума комісій");
    const cashbackHeader = headerByPrefix(table.headers, "Сума кешбеку");
    const cardCurrency = currencyFromHeader(cardAmountHeader);
    const feeCurrency = currencyFromHeader(feeHeader);
    const cashbackCurrency = currencyFromHeader(cashbackHeader);
    const accountIdentifier = metadataValue(table.preamble, "Рахунок:");
    const instrumentIdentifier = metadataValue(table.preamble, "Інформація по картці:");
    if (!accountIdentifier || !instrumentIdentifier) throw new Error("MONOBANK_METADATA_MISSING");
    const indices = indexHeaders(table.headers);
    return {
      accountIdentifier,
      instrumentIdentifier,
      cardCurrency,
      rows: table.rows.map(({ sourceRowNumber, values, hasFormula }) => ({
        sourceRowNumber,
        hasFormula,
        occurredAt: parseBankDate(cellValue(values, indices, dateHeader)),
        description: textValue(cellValue(values, indices, "Деталі операції")),
        mcc: normalizeMcc(cellValue(values, indices, "MCC")),
        cardAmount: cellValue(values, indices, cardAmountHeader),
        cardCurrency,
        transactionAmount: cellValue(values, indices, transactionAmountHeader),
        transactionCurrency: textValue(cellValue(values, indices, "Валюта")).toUpperCase(),
        providerRate: normalizeRate(cellValue(values, indices, "Курс")),
        feeAmount: cellValue(values, indices, feeHeader),
        feeCurrency,
        cashbackAmount: cellValue(values, indices, cashbackHeader),
        cashbackCurrency,
        resultingBalance: cellValue(values, indices, "Залишок після операції"),
      })),
    };
  }

  discoverAccounts(parsed: ParsedMonobankStatement): DiscoveredMonobankAccount[] {
    const instrumentIdentity = linkedInstrumentIdentity(parsed.accountIdentifier, parsed.instrumentIdentifier);
    return [{
      identifierHash: hmacIdentifier(parsed.accountIdentifier, this.#identifierKey),
      display: maskIdentifier(parsed.accountIdentifier),
      currencies: [parsed.cardCurrency],
      instrumentIdentifierHash: hmacIdentifier(instrumentIdentity, this.#identifierKey),
      instrumentDisplay: maskIdentifier(parsed.instrumentIdentifier),
    }];
  }

  normalize(parsed: ParsedMonobankStatement, context: OwnershipContext): NormalizationResult {
    const ownIdentifierHash = hmacIdentifier(parsed.accountIdentifier, this.#identifierKey);
    const instrumentIdentifierHash = hmacIdentifier(
      linkedInstrumentIdentity(parsed.accountIdentifier, parsed.instrumentIdentifier),
      this.#identifierKey,
    );
    return {
      kind: "monobank_personal",
      rows: parsed.rows.map((row): NormalizedSourceRow => {
        const rawIdentity = [
          row.occurredAt,
          parsed.accountIdentifier,
          parsed.instrumentIdentifier,
          row.description,
          row.mcc,
          row.cardAmount,
          row.cardCurrency,
          row.transactionAmount,
          row.transactionCurrency,
          row.providerRate,
          row.feeAmount,
          row.feeCurrency,
          row.cashbackAmount,
          row.cashbackCurrency,
          row.resultingBalance,
        ];
        const sourceRecordId = stableDigest([row.sourceRowNumber, ...rawIdentity]);
        const dedupeFingerprint = stableDigest(rawIdentity);
        const base = {
          sourceRowNumber: row.sourceRowNumber,
          sourceRecordId,
          dedupeFingerprint,
          observations: [],
          sourceMetadata: {
            mcc: row.mcc || null,
            providerRate: row.providerRate,
            explicitFeeMinor: null,
            explicitFeeCurrency: row.feeCurrency || null,
            cashbackMinor: null,
            cashbackCurrency: row.cashbackCurrency || null,
          },
        } satisfies Omit<NormalizedSourceRow, "state">;
        if (row.hasFormula) return { ...base, state: "rejected", reasonCode: "FORMULA_NOT_ALLOWED" };
        if (!row.occurredAt) return { ...base, state: "unresolved", reasonCode: "TRANSACTION_DATE_MISSING" };
        const target = context.ownership.get(ownIdentifierHash);
        if (!target) {
          return {
            ...base,
            state: "unresolved",
            reasonCode: context.mappingComplete ? "ACCOUNT_NOT_OWNED" : "OWNERSHIP_MAPPING_REQUIRED",
          };
        }
        if (target.instrumentIdentifierHash && target.instrumentIdentifierHash !== instrumentIdentifierHash) {
          return { ...base, state: "rejected", reasonCode: "INSTRUMENT_MAPPING_CONFLICT" };
        }
        try {
          const amountMinor = parseMinorUnits(row.cardAmount as string | number, row.cardCurrency);
          const sourceAmountMinor = parseMinorUnits(row.transactionAmount as string | number, row.transactionCurrency);
          const resultingBalanceMinor = parseMinorUnits(row.resultingBalance as string | number, row.cardCurrency);
          const explicitFeeMinor = parseMinorUnits(optionalMoneyInput(row.feeAmount), row.feeCurrency);
          const cashbackMinor = parseMinorUnits(optionalMoneyInput(row.cashbackAmount), row.cashbackCurrency);
          const sourceMetadata = {
            ...base.sourceMetadata,
            explicitFeeMinor: (explicitFeeMinor < 0n ? -explicitFeeMinor : explicitFeeMinor).toString(),
            cashbackMinor: (cashbackMinor < 0n ? -cashbackMinor : cashbackMinor).toString(),
          };
          const direction = amountMinor >= 0n ? "credit" : "debit";
          return {
            ...base,
            sourceMetadata,
            state: "posted",
            direction,
            observations: [{
              id: stableDigest([sourceRecordId, target.accountId, direction]),
              sourceRecordId,
              provider: "monobank",
              accountId: target.accountId,
              instrumentId: target.instrumentId,
              instrumentIdentifierHash,
              ownerScope: target.ownerScope,
              direction,
              amountMinor,
              currency: row.cardCurrency,
              sourceAmountMinor,
              sourceCurrency: row.transactionCurrency,
              resultingBalanceMinor,
              resultingBalanceCurrency: row.cardCurrency,
              occurredAt: row.occurredAt,
              ownIdentifierHash,
              description: row.description,
              ...(explicitFeeMinor === 0n ? {} : {
                explicitFeeMinor: explicitFeeMinor < 0n ? -explicitFeeMinor : explicitFeeMinor,
                explicitFeeCurrency: row.feeCurrency,
              }),
            }],
          };
        } catch (error) {
          return { ...base, state: "rejected", reasonCode: error instanceof Error ? error.message : "ROW_INVALID" };
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
    const observations = normalized.rows.flatMap(({ observations }) => observations)
      .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id));
    let checked = 0;
    let failed = 0;
    for (let index = 1; index < observations.length; index += 1) {
      const previous = observations[index - 1];
      const current = observations[index];
      if (!previous || !current || previous.accountId !== current.accountId || previous.currency !== current.currency) continue;
      if (previous.occurredAt === current.occurredAt) continue;
      if (previous.resultingBalanceMinor === undefined || current.resultingBalanceMinor === undefined) continue;
      checked += 1;
      if (previous.resultingBalanceMinor + current.amountMinor !== current.resultingBalanceMinor) failed += 1;
    }
    const totals = new Map<string, { credit: bigint[]; debit: bigint[] }>();
    for (const observation of observations) {
      const aggregate = totals.get(observation.currency) ?? { credit: [], debit: [] };
      if (observation.amountMinor >= 0n) aggregate.credit.push(observation.amountMinor);
      else aggregate.debit.push(-observation.amountMinor);
      totals.set(observation.currency, aggregate);
    }
    return {
      rowCount: normalized.rows.length,
      coveredRowCount: normalized.rows.length,
      silentlySkippedRowCount: 0,
      stateCounts,
      issues: failed > 0 ? ["BALANCE_DISCONTINUITY"] : [],
      balanceChecks: { checked, failed },
      totals: [...totals.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([currency, aggregate]) => ({
        currency,
        creditMinor: sumMinor(aggregate.credit),
        debitMinor: sumMinor(aggregate.debit),
      })),
    };
  }
}

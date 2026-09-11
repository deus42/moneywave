import { createHmac } from "node:crypto";

import { parseMinorUnits, sumMinor } from "@/domain/money";
import { hmacIdentifier, maskIdentifier } from "@/domain/privacy";
import { parsePrivatFxDescription } from "@/domain/privat-fx-evidence";
import type {
  NormalizationResult,
  NormalizedSourceRow,
  OwnershipContext,
  ProbeResult,
  ReconciliationSummary,
  SourceRowState,
  StatementAdapter,
  UndatedObservation,
} from "./types";
import { cellValue, indexHeaders, parseBankDate, readWorkbookTable, textValue } from "./workbook";

const HEADERS = [
  "№",
  "Дата проведення",
  "Сума",
  "Валюта",
  "Рахунок відправника",
  "Рахунок отримувача",
  "Призначення платежу",
  "Стан платежу",
] as const;

interface ParsedFopRow {
  sourceRowNumber: number;
  hasFormula: boolean;
  sourceNumber: string;
  conductedAt: string | null;
  amount: unknown;
  currency: string;
  senderAccount: string;
  senderName: string;
  recipientAccount: string;
  recipientName: string;
  purpose: string;
  status: string;
  createdAt: string | null;
  valueDate: string | null;
}

export interface ParsedFopJournal {
  rows: ParsedFopRow[];
}

export interface DiscoveredFopAccount {
  identifierHash: string;
  display: string;
  currencies: string[];
}

function emptyStateCounts(): Record<SourceRowState, number> {
  return { posted: 0, non_posted: 0, unresolved: 0, rejected: 0 };
}

export class PrivatFopJournalAdapter implements StatementAdapter<ParsedFopJournal> {
  readonly #identifierKey: Buffer;

  constructor({ identifierKey }: { identifierKey: Buffer }) {
    this.#identifierKey = identifierKey;
  }

  #privateDigest(parts: readonly unknown[]): string {
    return createHmac("sha256", this.#identifierKey).update(JSON.stringify(parts), "utf8").digest("hex");
  }

  probe(input: Buffer): ProbeResult {
    try {
      readWorkbookTable(input, HEADERS);
      return { matched: true, kind: "privat_fop_journal" };
    } catch {
      return { matched: false, reasonCode: "FORMAT_UNSUPPORTED" };
    }
  }

  parse(input: Buffer): ParsedFopJournal {
    const table = readWorkbookTable(input, HEADERS);
    const indices = indexHeaders(table.headers);
    return {
      rows: table.rows.map(({ sourceRowNumber, values, hasFormula }) => ({
        sourceRowNumber,
        hasFormula,
        sourceNumber: textValue(cellValue(values, indices, "№")),
        conductedAt: parseBankDate(cellValue(values, indices, "Дата проведення")),
        amount: cellValue(values, indices, "Сума"),
        currency: textValue(cellValue(values, indices, "Валюта")).toUpperCase(),
        senderAccount: textValue(cellValue(values, indices, "Рахунок відправника")),
        senderName: textValue(cellValue(values, indices, "Найменування відправника")),
        recipientAccount: textValue(cellValue(values, indices, "Рахунок отримувача")),
        recipientName: textValue(cellValue(values, indices, "Найменування отримувача")),
        purpose: textValue(cellValue(values, indices, "Призначення платежу")),
        status: textValue(cellValue(values, indices, "Стан платежу")),
        valueDate: parseBankDate(cellValue(values, indices, "Дата валютування")),
        createdAt: parseBankDate(cellValue(values, indices, "Дата створення")),
      })),
    };
  }

  discoverAccounts(parsed: ParsedFopJournal): DiscoveredFopAccount[] {
    const discovered = new Map<string, DiscoveredFopAccount>();
    for (const row of parsed.rows) {
      for (const identifier of [row.senderAccount, row.recipientAccount]) {
        if (!identifier) continue;
        const identifierHash = hmacIdentifier(identifier, this.#identifierKey);
        const existing = discovered.get(identifierHash);
        const currencies = new Set(existing?.currencies ?? []);
        if (row.currency) currencies.add(row.currency);
        discovered.set(identifierHash, {
          identifierHash,
          display: maskIdentifier(identifier),
          currencies: [...currencies].sort(),
        });
      }
    }
    return [...discovered.values()].sort((left, right) => left.display.localeCompare(right.display));
  }

  normalize(parsed: ParsedFopJournal, context: OwnershipContext): NormalizationResult {
    return {
      kind: "privat_fop_journal",
      rows: parsed.rows.map((row): NormalizedSourceRow => {
        const identity = [row.conductedAt, row.amount, row.currency, row.senderAccount, row.recipientAccount, row.status, row.valueDate, row.createdAt, row.purpose];
        const sourceRecordId = this.#privateDigest([row.sourceRowNumber, ...identity]);
        const dedupeFingerprint = this.#privateDigest(identity);
        const base = {
          sourceRowNumber: row.sourceRowNumber,
          sourceRecordId,
          dedupeFingerprint,
          observations: [],
          sourceMetadata: { sourceNumber: row.sourceNumber || null, status: row.status || null },
        } satisfies Omit<NormalizedSourceRow, "state">;

        if (row.hasFormula) return { ...base, state: "rejected", reasonCode: "FORMULA_NOT_ALLOWED" };
        if (row.status === "Збережено") return { ...base, state: "non_posted", reasonCode: "PAYMENT_SAVED" };
        if (row.status !== "Отримано" && row.status !== "Сплачено") {
          return { ...base, state: "rejected", reasonCode: "STATUS_UNSUPPORTED" };
        }
        if (!row.senderAccount || !row.recipientAccount) {
          return { ...base, state: "rejected", reasonCode: "ACCOUNT_IDENTIFIER_MISSING" };
        }

        const senderHash = hmacIdentifier(row.senderAccount, this.#identifierKey);
        const recipientHash = hmacIdentifier(row.recipientAccount, this.#identifierKey);
        const sender = context.ownership.get(senderHash);
        const recipient = context.ownership.get(recipientHash);
        if (!sender && !recipient && !context.mappingComplete) {
          return { ...base, state: "unresolved", reasonCode: "OWNERSHIP_MAPPING_REQUIRED" };
        }

        let amountMinor: bigint;
        try {
          amountMinor = parseMinorUnits(row.amount as string | number, row.currency);
        } catch (error) {
          return { ...base, state: "rejected", reasonCode: error instanceof Error ? error.message : "MONEY_INVALID" };
        }
        if (amountMinor < 0n) amountMinor = -amountMinor;
        const parsedFx = parsePrivatFxDescription(row.purpose);
        const fxSourceEvidence = parsedFx && parsedFx.soldCurrency !== row.currency
          ? { sourceAmountMinor: parsedFx.soldAmountMinor, sourceCurrency: parsedFx.soldCurrency }
          : {};

        let direction: NormalizedSourceRow["direction"] = "evidence_only";
        const undatedObservations: UndatedObservation[] = [];
        if (sender && recipient) {
          direction = "internal";
          undatedObservations.push({
            id: this.#privateDigest([sourceRecordId, sender.accountId, "debit"]),
            sourceRecordId,
            provider: "privatbank",
            accountId: sender.accountId,
            ownerScope: sender.ownerScope,
            direction: "debit",
            amountMinor: -amountMinor,
            currency: row.currency,
            ownIdentifierHash: senderHash,
            counterpartyIdentifierHash: recipientHash,
            description: row.purpose,
          }, {
            id: this.#privateDigest([sourceRecordId, recipient.accountId, "credit"]),
            sourceRecordId,
            provider: "privatbank",
            accountId: recipient.accountId,
            ownerScope: recipient.ownerScope,
            direction: "credit",
            amountMinor,
            currency: row.currency,
            ownIdentifierHash: recipientHash,
            counterpartyIdentifierHash: senderHash,
            description: row.purpose,
            ...fxSourceEvidence,
          });
        } else if (recipient) {
          direction = "credit";
          undatedObservations.push({
              id: this.#privateDigest([sourceRecordId, recipient.accountId, "credit"]),
              sourceRecordId,
              provider: "privatbank",
              accountId: recipient.accountId,
              ownerScope: recipient.ownerScope,
              direction: "credit",
              amountMinor,
              currency: row.currency,
              ownIdentifierHash: recipientHash,
              counterpartyIdentifierHash: senderHash,
              description: row.purpose,
              ...fxSourceEvidence,
          });
        } else if (sender) {
          direction = "debit";
          undatedObservations.push({
              id: this.#privateDigest([sourceRecordId, sender.accountId, "debit"]),
              sourceRecordId,
              provider: "privatbank",
              accountId: sender.accountId,
              ownerScope: sender.ownerScope,
              direction: "debit",
              amountMinor: -amountMinor,
              currency: row.currency,
              ownIdentifierHash: senderHash,
              counterpartyIdentifierHash: recipientHash,
              description: row.purpose,
          });
        }

        const conductedAt = row.conductedAt;
        if (!conductedAt) {
          return {
            ...base,
            state: "unresolved",
            reasonCode: "CONDUCTED_DATE_MISSING",
            direction,
            undatedObservations,
          };
        }
        return {
          ...base,
          state: "posted",
          direction,
          observations: undatedObservations.map((observation) => ({ ...observation, occurredAt: conductedAt })),
        };
      }),
    };
  }

  reconcile(normalized: NormalizationResult): ReconciliationSummary & {
    totals: Array<{ currency: string; creditMinor: bigint; debitMinor: bigint }>;
    balanceEvidence: "unavailable";
  } {
    const stateCounts = emptyStateCounts();
    const totals = new Map<string, { credit: bigint[]; debit: bigint[] }>();
    for (const row of normalized.rows) {
      stateCounts[row.state] += 1;
      for (const observation of row.observations) {
        const aggregate = totals.get(observation.currency) ?? { credit: [], debit: [] };
        if (observation.amountMinor >= 0n) aggregate.credit.push(observation.amountMinor);
        else aggregate.debit.push(-observation.amountMinor);
        totals.set(observation.currency, aggregate);
      }
    }
    return {
      rowCount: normalized.rows.length,
      coveredRowCount: normalized.rows.length,
      silentlySkippedRowCount: 0,
      stateCounts,
      issues: normalized.rows.flatMap((row) => row.reasonCode ? [row.reasonCode] : []).filter((value, index, all) => all.indexOf(value) === index),
      totals: [...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, aggregate]) => ({
        currency,
        creditMinor: sumMinor(aggregate.credit),
        debitMinor: sumMinor(aggregate.debit),
      })),
      balanceEvidence: "unavailable",
    };
  }
}

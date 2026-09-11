import { requireInt64 } from "./money";

export type ConsolidatedEntryKind =
  | "business_income"
  | "tax"
  | "mandatory_payment"
  | "business_expense"
  | "owner_draw"
  | "transfer_in"
  | "transfer_out"
  | "fx_sell"
  | "fx_buy"
  | "terminal_personal_expense"
  | "explicit_fee"
  | "unclassified";

export interface ConsolidatedEntry {
  amountMinor: bigint;
  currency: string;
  entryKind: ConsolidatedEntryKind;
}

export interface ConsolidatedCurrencyFlow {
  currency: string;
  grossIncomeMinor: bigint;
  spendingMinor: bigint;
  internalMovementMinor: bigint;
}

const SPENDING_KINDS = new Set<ConsolidatedEntryKind>([
  "tax",
  "mandatory_payment",
  "business_expense",
  "terminal_personal_expense",
  "explicit_fee",
]);
const INTERNAL_KINDS = new Set<ConsolidatedEntryKind>([
  "owner_draw",
  "transfer_out",
  "fx_sell",
  "fx_buy",
]);

export function calculateConsolidatedFlow(entries: readonly ConsolidatedEntry[]): ConsolidatedCurrencyFlow[] {
  const totals = new Map<string, ConsolidatedCurrencyFlow>();
  for (const entry of entries) {
    const currency = entry.currency.toUpperCase();
    const aggregate = totals.get(currency) ?? {
      currency,
      grossIncomeMinor: 0n,
      spendingMinor: 0n,
      internalMovementMinor: 0n,
    };
    const magnitude = entry.amountMinor < 0n ? -entry.amountMinor : entry.amountMinor;
    if (entry.entryKind === "business_income" && entry.amountMinor > 0n) {
      aggregate.grossIncomeMinor = requireInt64(aggregate.grossIncomeMinor + entry.amountMinor);
    } else if (SPENDING_KINDS.has(entry.entryKind) && entry.amountMinor < 0n) {
      aggregate.spendingMinor = requireInt64(aggregate.spendingMinor + magnitude);
    } else if (INTERNAL_KINDS.has(entry.entryKind)) {
      aggregate.internalMovementMinor = requireInt64(aggregate.internalMovementMinor + magnitude);
    }
    totals.set(currency, aggregate);
  }
  return [...totals.values()].sort((left, right) => left.currency.localeCompare(right.currency));
}

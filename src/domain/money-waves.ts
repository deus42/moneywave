import type { ReportCurrency, ReportPeriod } from "./reporting";

/** Decimal strings cross the server/client boundary without losing integer precision. */
export interface WaveMoney {
  native: { currency: string; minor: string }[];
  reportMinor: string | null;
  missing: number;
  count: number;
}
export type WaveCostMethod = "explicit_statement_fee" | "same_currency_transfer_gap" | "fx_spread_estimate" | "manual_cost" | "unexplained_gap";
export interface WaveCost { method: WaveCostMethod; amount: WaveMoney }
export interface WaveBalance {
  nativeMinor: string | null;
  reportMinor: string | null;
  observedAt: string | null;
  precision: "day" | "month";
  source: string | null;
  status: "known" | "missing_balance" | "missing_rate" | "conflict";
  carriedForward: boolean;
  cashGapMinor: string | null;
  rateDate: string | null;
  rateStale: boolean;
}
export interface WaveNode {
  id: string;
  label: string;
  provider: string;
  currency: string;
  kind: "account" | "manual" | "source_pool" | "boundary" | "junction";
  stage: number;
  balance: WaveBalance | null;
  income: WaveMoney;
  spending: WaveMoney;
  taxes: WaveMoney;
  business: WaveMoney;
  costs: WaveCost[];
  cash: { inflow: WaveMoney; outflow: WaveMoney } | null;
}
export interface WaveLink {
  id: string;
  from: string;
  to: string;
  kind: "transfer" | "fx" | "incomplete" | "junction";
  sent: WaveMoney;
  received: WaveMoney;
  count: number;
  costs: WaveCost[];
}
export interface MoneyWavesView {
  period: ReportPeriod;
  currency: ReportCurrency;
  asOf: string;
  startAt: string | null;
  nodes: WaveNode[];
  links: WaveLink[];
  summary: {
    knownNetMinor: string;
    missingBalances: number;
    carriedBalances: number;
    income: WaveMoney;
    spending: WaveMoney;
    taxes: WaveMoney;
    business: WaveMoney;
    costs: WaveCost[];
    incomplete: number;
    undated: number;
    unclassified: number;
    uncategorized: number;
    fxWithoutEstimate: number;
  };
}

export const emptyWaveMoney = (): WaveMoney => ({ native: [], reportMinor: "0", missing: 0, count: 0 });
export const unknownWaveMoney = (): WaveMoney => ({ native: [], reportMinor: null, missing: 1, count: 0 });

/** Missing conversions stay visible; known subtotals are never presented as complete totals. */
export function addWaveMoney(left: WaveMoney, right: WaveMoney): WaveMoney {
  const currencies = new Map<string, bigint>();
  for (const value of [...left.native, ...right.native]) currencies.set(value.currency, (currencies.get(value.currency) ?? 0n) + BigInt(value.minor));
  const known = (left.count > left.missing && left.reportMinor !== null) || (right.count > right.missing && right.reportMinor !== null);
  const count = left.count + right.count;
  return {
    native: [...currencies].sort(([a], [b]) => a.localeCompare(b)).map(([currency, minor]) => ({ currency, minor: minor.toString() })),
    reportMinor: known || (count === 0 && left.missing + right.missing === 0) ? (BigInt(left.reportMinor ?? "0") + BigInt(right.reportMinor ?? "0")).toString() : null,
    missing: left.missing + right.missing, count,
  };
}

export function addWaveCosts(left: WaveCost[], right: WaveCost[]): WaveCost[] {
  const methods = new Map(left.map(cost => [cost.method, cost.amount]));
  for (const cost of right) methods.set(cost.method, addWaveMoney(methods.get(cost.method) ?? emptyWaveMoney(), cost.amount));
  return [...methods].sort(([a], [b]) => a.localeCompare(b)).map(([method, amount]) => ({ method, amount }));
}

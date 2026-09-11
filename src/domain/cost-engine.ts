import Decimal from "decimal.js";

import { currencyMinorDigits, type Money, requireInt64, sumMinor } from "./money";

export type CostMethod =
  | "explicit_statement_fee"
  | "same_currency_transfer_gap"
  | "fx_spread_estimate"
  | "manual_cost"
  | "unexplained_gap";

export interface CostComponent {
  method: CostMethod;
  amountMinor: bigint;
  currency: string;
  estimated: boolean;
}

export function analyzeSameCurrencyCost(input: {
  currency: string;
  sourceDebitsMinor: readonly bigint[];
  destinationCreditsMinor: readonly bigint[];
  explicitFeesMinor: readonly bigint[];
  manualCostsMinor?: readonly bigint[];
  confirmResidualAsTransferGap: boolean;
}): {
  components: CostComponent[];
  observedGapMinor: bigint;
  residualMinor: bigint;
  reconciled: boolean;
} {
  const currency = input.currency.toUpperCase();
  currencyMinorDigits(currency);
  const source = sumMinor(input.sourceDebitsMinor.map((value) => value < 0n ? -value : value));
  const destination = sumMinor(input.destinationCreditsMinor.map((value) => value < 0n ? -value : value));
  const fees = sumMinor(input.explicitFeesMinor.map((value) => value < 0n ? -value : value));
  const manualCosts = sumMinor((input.manualCostsMinor ?? []).map((value) => value < 0n ? -value : value));
  const observedGapMinor = requireInt64(source - destination - fees - manualCosts);
  const components: CostComponent[] = input.explicitFeesMinor
    .filter((amountMinor) => amountMinor !== 0n)
    .map((amountMinor) => ({ method: "explicit_statement_fee", amountMinor: amountMinor < 0n ? -amountMinor : amountMinor, currency, estimated: false }));
  components.push(...(input.manualCostsMinor ?? [])
    .filter((amountMinor) => amountMinor !== 0n)
    .map((amountMinor): CostComponent => ({ method: "manual_cost", amountMinor: amountMinor < 0n ? -amountMinor : amountMinor, currency, estimated: false })));

  if (observedGapMinor === 0n) {
    return { components, observedGapMinor, residualMinor: 0n, reconciled: true };
  }
  if (observedGapMinor > 0n && input.confirmResidualAsTransferGap) {
    components.push({ method: "same_currency_transfer_gap", amountMinor: observedGapMinor, currency, estimated: false });
    return { components, observedGapMinor, residualMinor: 0n, reconciled: true };
  }
  components.push({ method: "unexplained_gap", amountMinor: observedGapMinor, currency, estimated: false });
  return { components, observedGapMinor, residualMinor: observedGapMinor, reconciled: false };
}

export function analyzeFxCost(input: {
  sold: Money;
  received: Money;
  benchmarkRate: string | null;
  benchmarkSource: string | null;
  publicationDate: string | null;
  explicitFeeMinor: bigint;
  manualCostMinor?: bigint;
}): {
  executedRate: string;
  benchmarkAmountMinor: bigint;
  totalFxCostMinor: bigint;
  components: CostComponent[];
  auditEvidence: { benchmarkSource: string; publicationDate: string; formula: string };
} {
  if (!input.benchmarkRate || !input.benchmarkSource || !input.publicationDate) {
    throw new Error("FX_BENCHMARK_MISSING");
  }
  if (input.sold.currency === input.received.currency || input.sold.amountMinor <= 0n || input.received.amountMinor <= 0n) {
    throw new Error("FX_LEGS_INVALID");
  }
  let benchmarkRate: Decimal;
  try {
    benchmarkRate = new Decimal(input.benchmarkRate);
  } catch {
    throw new Error("FX_BENCHMARK_INVALID");
  }
  if (!benchmarkRate.isFinite() || benchmarkRate.lte(0)) throw new Error("FX_BENCHMARK_INVALID");

  const soldScale = new Decimal(10).pow(currencyMinorDigits(input.sold.currency));
  const receivedScale = new Decimal(10).pow(currencyMinorDigits(input.received.currency));
  const soldMajor = new Decimal(input.sold.amountMinor.toString()).div(soldScale);
  const receivedMajor = new Decimal(input.received.amountMinor.toString()).div(receivedScale);
  const executedRate = receivedMajor.div(soldMajor).toSignificantDigits(20).toString();
  const benchmarkAmountMinor = requireInt64(BigInt(
    soldMajor.mul(benchmarkRate).mul(receivedScale).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0),
  ));
  const totalFxCostMinor = requireInt64(benchmarkAmountMinor - input.received.amountMinor);
  const explicitFee = input.explicitFeeMinor < 0n ? -input.explicitFeeMinor : input.explicitFeeMinor;
  const manualCost = (input.manualCostMinor ?? 0n) < 0n ? -(input.manualCostMinor ?? 0n) : (input.manualCostMinor ?? 0n);
  const residualSpread = requireInt64(totalFxCostMinor - explicitFee - manualCost);
  const components: CostComponent[] = [];
  if (explicitFee !== 0n) {
    components.push({ method: "explicit_statement_fee", amountMinor: explicitFee, currency: input.received.currency, estimated: false });
  }
  if (manualCost !== 0n) {
    components.push({ method: "manual_cost", amountMinor: manualCost, currency: input.received.currency, estimated: false });
  }
  if (residualSpread !== 0n) {
    components.push({ method: residualSpread > 0n ? "fx_spread_estimate" : "unexplained_gap", amountMinor: residualSpread, currency: input.received.currency, estimated: residualSpread > 0n });
  }
  return {
    executedRate,
    benchmarkAmountMinor,
    totalFxCostMinor,
    components,
    auditEvidence: {
      benchmarkSource: input.benchmarkSource,
      publicationDate: input.publicationDate,
      formula: "benchmark_amount = sold_amount × official_rate; total_fx_cost = benchmark_amount − received_amount",
    },
  };
}

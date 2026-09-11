import Decimal from "decimal.js";

import { currencyMinorDigits } from "@/domain/money";
import type { OwnerScope } from "@/server/import/types";

export type AutonomousMatchKind = "exact" | "near_amount" | "cross_currency";
export type AutonomousEvidenceKind =
  | "provider_reference"
  | "same_source_record"
  | "provider_source_amount"
  | "reciprocal_accounts"
  | "account_hint"
  | "automatic_exact"
  | "automatic_near"
  | "automatic_fx";

export interface AutonomousMatchObservation {
  id: string;
  accountId: string;
  provider: string;
  ownerScope: OwnerScope;
  direction: "debit" | "credit";
  amountMinor: bigint;
  currency: string;
  occurredAt: string;
  transferSignal: boolean;
  fxSignal: boolean;
  sourceRecordIds: readonly string[];
  providerReferences: readonly string[];
  sourceAmounts: ReadonlyArray<{ amountMinor: bigint; currency: string }>;
  identifierPairs: ReadonlyArray<{
    ownIdentifierHash: string;
    counterpartyIdentifierHash: string;
  }>;
  counterpartyAccountIds: readonly string[];
}

export interface AutonomousMovementMatch {
  debitId: string;
  creditId: string;
  matchKind: AutonomousMatchKind;
  evidenceKind: AutonomousEvidenceKind;
  score: number;
  residualMinor: bigint;
}

interface CandidateEdge extends AutonomousMovementMatch {
  debitIndex: number;
  creditIndex: number;
}

const MIN_SCORE: Readonly<Record<AutonomousMatchKind, number>> = {
  exact: 600,
  near_amount: 400,
  cross_currency: 200,
};

export interface FxBenchmarkRateInput {
  base: string;
  quote: string;
  onOrBeforeDate: string;
}

export interface AutonomousMatcherOptions {
  uniquenessMargin?: number;
  fxBenchmarkRate?: (input: FxBenchmarkRateInput) => string | null;
}

function magnitude(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function intersects(left: readonly string[], right: readonly string[]): boolean {
  if (left.length === 0 || right.length === 0) return false;
  const values = new Set(left.filter(Boolean));
  return right.some((value) => Boolean(value && values.has(value)));
}

function hasReciprocalIdentifiers(left: AutonomousMatchObservation, right: AutonomousMatchObservation): boolean {
  return left.identifierPairs.some((leftPair) => right.identifierPairs.some((rightPair) => (
    leftPair.ownIdentifierHash === rightPair.counterpartyIdentifierHash
    && leftPair.counterpartyIdentifierHash === rightPair.ownIdentifierHash
  )));
}

function hasAccountHint(left: AutonomousMatchObservation, right: AutonomousMatchObservation): boolean {
  return left.counterpartyAccountIds.includes(right.accountId)
    || right.counterpartyAccountIds.includes(left.accountId);
}

function providerSourceAmountStrength(left: AutonomousMatchObservation, right: AutonomousMatchObservation): number {
  if (left.provider !== right.provider || left.currency === right.currency) return 0;
  const leftMatches = left.sourceAmounts.some(({ amountMinor, currency }) => (
    currency === right.currency && magnitude(amountMinor) === magnitude(right.amountMinor)
  ));
  const rightMatches = right.sourceAmounts.some(({ amountMinor, currency }) => (
    currency === left.currency && magnitude(amountMinor) === magnitude(left.amountMinor)
  ));
  return Number(leftMatches) + Number(rightMatches);
}

function timeDistanceMinutes(left: AutonomousMatchObservation, right: AutonomousMatchObservation): number {
  const leftTime = Date.parse(left.occurredAt);
  const rightTime = Date.parse(right.occurredAt);
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return Number.POSITIVE_INFINITY;
  return Math.abs(leftTime - rightTime) / 60_000;
}

function temporalScore(minutes: number): number {
  // Provider timestamps are the strongest discriminator when two otherwise
  // identical transfers occur close together. Keep an exact timestamp at
  // least one uniqueness margin above a merely nearby observation.
  if (minutes === 0) return 50;
  if (minutes <= 5) return 30;
  if (minutes <= 60) return 22;
  if (minutes <= 6 * 60) return 14;
  if (minutes <= 24 * 60) return 8;
  if (minutes <= 72 * 60) return 2;
  return -100;
}

function evidenceForPair(
  debit: AutonomousMatchObservation,
  credit: AutonomousMatchObservation,
  minutes: number,
): AutonomousEvidenceKind | null {
  if (
    debit.provider === credit.provider
    && intersects(debit.providerReferences, credit.providerReferences)
  ) return "provider_reference";
  if (intersects(debit.sourceRecordIds, credit.sourceRecordIds)) return "same_source_record";
  if (minutes <= 5 && providerSourceAmountStrength(debit, credit) > 0) return "provider_source_amount";
  if (hasReciprocalIdentifiers(debit, credit)) return "reciprocal_accounts";
  if (hasAccountHint(debit, credit)) return "account_hint";
  return null;
}

function fxPlausibility(
  debit: AutonomousMatchObservation,
  credit: AutonomousMatchObservation,
  lookup: AutonomousMatcherOptions["fxBenchmarkRate"],
): { plausible: boolean; score: number } {
  if (!lookup) return { plausible: false, score: 0 };
  const benchmarkText = lookup({
    base: debit.currency,
    quote: credit.currency,
    onOrBeforeDate: debit.occurredAt.slice(0, 10),
  });
  if (!benchmarkText) return { plausible: false, score: 0 };
  try {
    const soldScale = new Decimal(10).pow(currencyMinorDigits(debit.currency));
    const receivedScale = new Decimal(10).pow(currencyMinorDigits(credit.currency));
    const executed = new Decimal(magnitude(credit.amountMinor).toString()).div(receivedScale)
      .div(new Decimal(magnitude(debit.amountMinor).toString()).div(soldScale));
    const benchmark = new Decimal(benchmarkText);
    if (!executed.isFinite() || !benchmark.isFinite() || executed.lte(0) || benchmark.lte(0)) {
      return { plausible: false, score: 0 };
    }
    const deviation = executed.sub(benchmark).abs().div(benchmark);
    if (deviation.gt(0.1)) return { plausible: false, score: 0 };
    return { plausible: true, score: Math.max(0, 100 - Math.round(deviation.mul(1_000).toNumber())) };
  } catch {
    return { plausible: false, score: 0 };
  }
}

function scorePair(
  debit: AutonomousMatchObservation,
  credit: AutonomousMatchObservation,
  options: AutonomousMatcherOptions,
): Omit<CandidateEdge, "debitIndex" | "creditIndex"> | null {
  if (debit.accountId === credit.accountId) return null;
  const minutes = timeDistanceMinutes(debit, credit);
  if (minutes > 72 * 60) return null;

  const debitMagnitude = magnitude(debit.amountMinor);
  const creditMagnitude = magnitude(credit.amountMinor);
  if (debitMagnitude === 0n || creditMagnitude === 0n) return null;
  const hardEvidence = evidenceForPair(debit, credit, minutes);
  const providerSourceStrength = hardEvidence === "provider_source_amount"
    ? providerSourceAmountStrength(debit, credit)
    : 0;
  const sourceDiversity = debit.provider !== credit.provider ? 4 : 0;
  const ownerDrawShape = debit.ownerScope === "SOLE_PROPRIETOR" && credit.ownerScope === "PERSONAL" ? 8 : 0;
  const signals = Number(debit.transferSignal || debit.fxSignal) * 7 + Number(credit.transferSignal || credit.fxSignal) * 7;

  if (debit.currency === credit.currency && debitMagnitude === creditMagnitude) {
    const oneSidedTransferWindow = debit.provider !== credit.provider ? 6 * 60 : 5;
    const oneSidedTransfer = (debit.transferSignal || credit.transferSignal)
      && minutes <= oneSidedTransferWindow;
    if (!hardEvidence && !(debit.transferSignal && credit.transferSignal) && !oneSidedTransfer) return null;
    return {
      debitId: debit.id,
      creditId: credit.id,
      matchKind: "exact",
      evidenceKind: hardEvidence ?? "automatic_exact",
      score: hardEvidence ? 2_000 + temporalScore(minutes) : 600 + temporalScore(minutes) + sourceDiversity + ownerDrawShape + signals,
      residualMinor: 0n,
    };
  }

  if (debit.currency === credit.currency) {
    const oneSidedCrossProviderTransfer = debit.provider !== credit.provider
      && (debit.transferSignal || credit.transferSignal)
      && minutes <= 5;
    if ((!debit.transferSignal || !credit.transferSignal) && !oneSidedCrossProviderTransfer) return null;
    if (debitMagnitude < creditMagnitude) return null;
    const residual = debitMagnitude - creditMagnitude;
    if (residual * 100n > debitMagnitude * 2n) return null;
    return {
      debitId: debit.id,
      creditId: credit.id,
      matchKind: "near_amount",
      evidenceKind: hardEvidence ?? "automatic_near",
      score: hardEvidence ? 1_900 + temporalScore(minutes) : 400 + temporalScore(minutes) + sourceDiversity + ownerDrawShape + signals,
      residualMinor: residual,
    };
  }

  const sharedHardEvidence = hardEvidence === "same_source_record"
    || hardEvidence === "provider_reference"
    || hardEvidence === "provider_source_amount"
    || hardEvidence === "reciprocal_accounts";
  const fxShape = debit.fxSignal || credit.fxSignal || (debit.transferSignal && credit.transferSignal);
  const plausibility = fxPlausibility(debit, credit, options.fxBenchmarkRate);
  if (!sharedHardEvidence && (!fxShape || !plausibility.plausible || minutes > 6 * 60)) return null;
  return {
    debitId: debit.id,
    creditId: credit.id,
    matchKind: "cross_currency",
    evidenceKind: hardEvidence ?? "automatic_fx",
    score: sharedHardEvidence
      ? 2_000 + temporalScore(minutes) + providerSourceStrength * 100
      : 200 + temporalScore(minutes) + sourceDiversity + signals + plausibility.score
        + (hardEvidence === "account_hint" ? 120 : 0)
        + (debit.ownerScope === credit.ownerScope ? 4 : 0),
    residualMinor: 0n,
  };
}

function topScores(edges: readonly CandidateEdge[], side: "debitId" | "creditId"): Map<string, [number, number]> {
  const scores = new Map<string, number[]>();
  for (const edge of edges) {
    const key = edge[side];
    const values = scores.get(key) ?? [];
    values.push(edge.score);
    scores.set(key, values);
  }
  const output = new Map<string, [number, number]>();
  for (const [key, values] of scores) {
    values.sort((left, right) => right - left);
    output.set(key, [values[0] ?? Number.NEGATIVE_INFINITY, values[1] ?? Number.NEGATIVE_INFINITY]);
  }
  return output;
}

function sufficientlyUnique(score: number, ranking: [number, number] | undefined, margin: number): boolean {
  if (!ranking || score !== ranking[0]) return false;
  return ranking[1] === Number.NEGATIVE_INFINITY || score - ranking[1] >= margin;
}

function maximumWeightAssignment(
  edges: readonly CandidateEdge[],
): CandidateEdge[] {
  const activeDebitIndices = [...new Set(edges.map(({ debitIndex }) => debitIndex))].sort((left, right) => left - right);
  const activeCreditIndices = [...new Set(edges.map(({ creditIndex }) => creditIndex))].sort((left, right) => left - right);
  const debitPosition = new Map(activeDebitIndices.map((index, position) => [index, position]));
  const creditPosition = new Map(activeCreditIndices.map((index, position) => [index, position]));
  const debitCount = activeDebitIndices.length;
  const creditCount = activeCreditIndices.length;
  const size = Math.max(debitCount, creditCount);
  if (size === 0 || edges.length === 0) return [];
  const edgeByCell = new Map<string, CandidateEdge>();
  let maximum = 0;
  for (const edge of edges) {
    const debitIndex = debitPosition.get(edge.debitIndex);
    const creditIndex = creditPosition.get(edge.creditIndex);
    if (debitIndex === undefined || creditIndex === undefined) throw new Error("MOVEMENT_ASSIGNMENT_INDEX_INVALID");
    edgeByCell.set(`${debitIndex}:${creditIndex}`, edge);
    maximum = Math.max(maximum, edge.score);
  }

  // Hungarian assignment on a square matrix padded with zero-weight no-match cells.
  const u = Array<number>(size + 1).fill(0);
  const v = Array<number>(size + 1).fill(0);
  const p = Array<number>(size + 1).fill(0);
  const way = Array<number>(size + 1).fill(0);
  const cost = (row: number, column: number): number => {
    const edge = edgeByCell.get(`${row - 1}:${column - 1}`);
    return maximum - (edge?.score ?? 0);
  };

  for (let row = 1; row <= size; row += 1) {
    p[0] = row;
    let column0 = 0;
    const min = Array<number>(size + 1).fill(Number.POSITIVE_INFINITY);
    const used = Array<boolean>(size + 1).fill(false);
    do {
      used[column0] = true;
      const row0 = p[column0]!;
      let delta = Number.POSITIVE_INFINITY;
      let column1 = 0;
      for (let column = 1; column <= size; column += 1) {
        if (used[column]) continue;
        const current = cost(row0, column) - u[row0]! - v[column]!;
        if (current < min[column]!) {
          min[column] = current;
          way[column] = column0;
        }
        if (min[column]! < delta) {
          delta = min[column]!;
          column1 = column;
        }
      }
      for (let column = 0; column <= size; column += 1) {
        if (used[column]) {
          u[p[column]!] = u[p[column]!]! + delta;
          v[column] = v[column]! - delta;
        } else {
          min[column] = min[column]! - delta;
        }
      }
      column0 = column1;
    } while (p[column0] !== 0);
    do {
      const previous = way[column0]!;
      p[column0] = p[previous]!;
      column0 = previous;
    } while (column0 !== 0);
  }

  const selected: CandidateEdge[] = [];
  for (let column = 1; column <= size; column += 1) {
    const row = p[column]!;
    const edge = edgeByCell.get(`${row - 1}:${column - 1}`);
    if (edge) selected.push(edge);
  }
  return selected.sort((left, right) => left.debitId.localeCompare(right.debitId) || left.creditId.localeCompare(right.creditId));
}

export function resolveAutonomousMovements(
  observations: readonly AutonomousMatchObservation[],
  options: AutonomousMatcherOptions = {},
): {
  matches: AutonomousMovementMatch[];
  ambiguousObservationIds: string[];
  unmatchedObservationIds: string[];
} {
  const uniquenessMargin = Math.max(0, options.uniquenessMargin ?? 12);
  const debits = observations.filter(({ direction }) => direction === "debit").sort((left, right) => left.id.localeCompare(right.id));
  const credits = observations.filter(({ direction }) => direction === "credit").sort((left, right) => left.id.localeCompare(right.id));
  const edges: CandidateEdge[] = [];
  for (const [debitIndex, debit] of debits.entries()) {
    for (const [creditIndex, credit] of credits.entries()) {
      const edge = scorePair(debit, credit, options);
      if (edge) edges.push({ ...edge, debitIndex, creditIndex });
    }
  }

  const debitScores = topScores(edges, "debitId");
  const creditScores = topScores(edges, "creditId");
  const eligible = edges.filter((edge) => (
    edge.score >= MIN_SCORE[edge.matchKind]
    && sufficientlyUnique(edge.score, debitScores.get(edge.debitId), uniquenessMargin)
    && sufficientlyUnique(edge.score, creditScores.get(edge.creditId), uniquenessMargin)
  ));
  const selected = maximumWeightAssignment(eligible);
  const matched = new Set(selected.flatMap(({ debitId, creditId }) => [debitId, creditId]));
  const ambiguous = new Set<string>();
  for (const edge of edges) {
    const debitUnique = sufficientlyUnique(edge.score, debitScores.get(edge.debitId), uniquenessMargin);
    const creditUnique = sufficientlyUnique(edge.score, creditScores.get(edge.creditId), uniquenessMargin);
    if (!matched.has(edge.debitId) && (!debitUnique || !creditUnique)) ambiguous.add(edge.debitId);
    if (!matched.has(edge.creditId) && (!debitUnique || !creditUnique)) ambiguous.add(edge.creditId);
  }

  return {
    matches: selected.map((match) => ({
      debitId: match.debitId,
      creditId: match.creditId,
      matchKind: match.matchKind,
      evidenceKind: match.evidenceKind,
      score: match.score,
      residualMinor: match.residualMinor,
    })),
    ambiguousObservationIds: [...ambiguous].sort(),
    unmatchedObservationIds: observations.map(({ id }) => id).filter((id) => !matched.has(id)).sort(),
  };
}

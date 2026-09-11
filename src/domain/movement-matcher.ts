export type MatchDirection = "debit" | "credit";

export interface MatchObservation {
  id: string;
  sourceRecordId: string;
  provider: string;
  accountId: string;
  direction: MatchDirection;
  amountMinor: bigint;
  currency: string;
  occurredAt: string;
  providerReference?: string;
  providerReferences?: readonly string[];
  sourceRecordIds?: readonly string[];
  ownIdentifierHash?: string;
  counterpartyIdentifierHash?: string;
  identifierPairs?: ReadonlyArray<{
    ownIdentifierHash: string;
    counterpartyIdentifierHash: string;
  }>;
}

export type LinkEvidenceKind = "provider_reference" | "same_source_record" | "reciprocal_accounts" | "manual";
export type CandidateMatchKind = "exact" | "near_amount" | "cross_currency";

export interface ConfirmedMovementGroup {
  id: string;
  evidenceKind: LinkEvidenceKind;
  observationIds: [string, string];
}

export interface MovementCandidate {
  id: string;
  matchKind: CandidateMatchKind;
  observationIds: [string, string];
  requiresConfirmation: true;
}

function pairId(prefix: string, left: MatchObservation, right: MatchObservation): string {
  return `${prefix}:${[left.id, right.id].sort().join(":")}`;
}

function isOpposing(left: MatchObservation, right: MatchObservation): boolean {
  return left.direction !== right.direction && left.accountId !== right.accountId;
}

function debitAndCredit(left: MatchObservation, right: MatchObservation): [MatchObservation, MatchObservation] {
  return left.direction === "debit" ? [left, right] : [right, left];
}

function exactMagnitude(left: MatchObservation, right: MatchObservation): boolean {
  return (left.amountMinor < 0n ? -left.amountMinor : left.amountMinor)
    === (right.amountMinor < 0n ? -right.amountMinor : right.amountMinor);
}

function exactTime(left: MatchObservation, right: MatchObservation): boolean {
  return left.occurredAt === right.occurredAt;
}

function sameCalendarDate(left: MatchObservation, right: MatchObservation): boolean {
  return left.occurredAt.slice(0, 10) === right.occurredAt.slice(0, 10);
}

function reciprocalIdentifiers(left: MatchObservation, right: MatchObservation): boolean {
  const pairs = (observation: MatchObservation) => {
    const evidencePairs = [...(observation.identifierPairs ?? [])];
    if (observation.ownIdentifierHash && observation.counterpartyIdentifierHash) {
      evidencePairs.push({
        ownIdentifierHash: observation.ownIdentifierHash,
        counterpartyIdentifierHash: observation.counterpartyIdentifierHash,
      });
    }
    return evidencePairs;
  };
  return pairs(left).some((leftPair) => pairs(right).some((rightPair) => (
    leftPair.ownIdentifierHash === rightPair.counterpartyIdentifierHash
    && rightPair.ownIdentifierHash === leftPair.counterpartyIdentifierHash
  )));
}

function sharesSourceRecord(left: MatchObservation, right: MatchObservation): boolean {
  const leftIds = new Set([left.sourceRecordId, ...(left.sourceRecordIds ?? [])]);
  return [right.sourceRecordId, ...(right.sourceRecordIds ?? [])].some((id) => leftIds.has(id));
}

function sharesProviderReference(left: MatchObservation, right: MatchObservation): boolean {
  if (left.provider !== right.provider) return false;
  const leftReferences = new Set([left.providerReference, ...(left.providerReferences ?? [])].filter((value): value is string => Boolean(value)));
  return [right.providerReference, ...(right.providerReferences ?? [])]
    .some((reference) => Boolean(reference && leftReferences.has(reference)));
}

function nearMagnitude(left: MatchObservation, right: MatchObservation): boolean {
  const leftAbs = left.amountMinor < 0n ? -left.amountMinor : left.amountMinor;
  const rightAbs = right.amountMinor < 0n ? -right.amountMinor : right.amountMinor;
  const maximum = leftAbs > rightAbs ? leftAbs : rightAbs;
  if (maximum === 0n) return false;
  const difference = leftAbs > rightAbs ? leftAbs - rightAbs : rightAbs - leftAbs;
  return difference * 100n <= maximum * 2n;
}

export function buildMovementResolution(observations: readonly MatchObservation[]): {
  confirmedGroups: ConfirmedMovementGroup[];
  candidates: MovementCandidate[];
  unlinkedObservationIds: string[];
} {
  const used = new Set<string>();
  const confirmedGroups: ConfirmedMovementGroup[] = [];
  const orderedEvidence: Array<[LinkEvidenceKind, (left: MatchObservation, right: MatchObservation) => boolean]> = [
    ["provider_reference", (left, right) => sharesProviderReference(left, right) && left.currency === right.currency && exactMagnitude(left, right)],
    ["same_source_record", (left, right) => sharesSourceRecord(left, right) && left.currency === right.currency && exactMagnitude(left, right)],
    ["reciprocal_accounts", (left, right) => reciprocalIdentifiers(left, right) && left.currency === right.currency && exactMagnitude(left, right) && exactTime(left, right)],
  ];

  for (const [evidenceKind, matches] of orderedEvidence) {
    for (let leftIndex = 0; leftIndex < observations.length; leftIndex += 1) {
      const left = observations[leftIndex];
      if (!left || used.has(left.id)) continue;
      for (let rightIndex = leftIndex + 1; rightIndex < observations.length; rightIndex += 1) {
        const right = observations[rightIndex];
        if (!right || used.has(right.id) || !isOpposing(left, right) || !matches(left, right)) continue;
        const [debit, credit] = debitAndCredit(left, right);
        confirmedGroups.push({ id: pairId("movement", debit, credit), evidenceKind, observationIds: [debit.id, credit.id] });
        used.add(left.id);
        used.add(right.id);
        break;
      }
    }
  }

  const candidates: MovementCandidate[] = [];
  const candidateUsed = new Set<string>();
  for (let leftIndex = 0; leftIndex < observations.length; leftIndex += 1) {
    const left = observations[leftIndex];
    if (!left || used.has(left.id) || candidateUsed.has(left.id)) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < observations.length; rightIndex += 1) {
      const right = observations[rightIndex];
      if (!right || used.has(right.id) || candidateUsed.has(right.id) || !isOpposing(left, right) || !sameCalendarDate(left, right)) continue;
      let matchKind: CandidateMatchKind | null = null;
      if (left.currency !== right.currency) matchKind = "cross_currency";
      else if (exactMagnitude(left, right)) matchKind = "exact";
      else if (nearMagnitude(left, right)) matchKind = "near_amount";
      if (!matchKind) continue;
      const [debit, credit] = debitAndCredit(left, right);
      candidates.push({ id: pairId("candidate", debit, credit), matchKind, observationIds: [debit.id, credit.id], requiresConfirmation: true });
      candidateUsed.add(left.id);
      candidateUsed.add(right.id);
      break;
    }
  }

  return {
    confirmedGroups,
    candidates,
    unlinkedObservationIds: observations.filter(({ id }) => !used.has(id) && !candidateUsed.has(id)).map(({ id }) => id),
  };
}

export function mergeCanonicalEvidence(observations: readonly MatchObservation[]): {
  transactions: Array<{ id: string; evidenceIds: string[]; amountMinor: bigint; currency: string; direction: MatchDirection }>;
  conflicts: Array<{ evidenceId: string; canonicalId: string; reasonCode: "SOURCE_OBSERVATION_CONFLICT" }>;
} {
  const transactions: Array<{ id: string; evidenceIds: string[]; amountMinor: bigint; currency: string; direction: MatchDirection }> = [];
  const conflicts: Array<{ evidenceId: string; canonicalId: string; reasonCode: "SOURCE_OBSERVATION_CONFLICT" }> = [];
  const keyed = new Map<string, typeof transactions[number]>();
  for (const observation of observations) {
    const key = observation.providerReference
      ? `${observation.provider}:${observation.providerReference}:${observation.accountId}`
      : `evidence:${observation.id}`;
    const existing = keyed.get(key);
    if (!existing) {
      const transaction = {
        id: `transaction:${key}`,
        evidenceIds: [observation.id],
        amountMinor: observation.amountMinor,
        currency: observation.currency,
        direction: observation.direction,
      };
      keyed.set(key, transaction);
      transactions.push(transaction);
    } else if (
      existing.amountMinor === observation.amountMinor
      && existing.currency === observation.currency
      && existing.direction === observation.direction
    ) {
      existing.evidenceIds.push(observation.id);
    } else {
      conflicts.push({ evidenceId: observation.id, canonicalId: existing.id, reasonCode: "SOURCE_OBSERVATION_CONFLICT" });
    }
  }
  return { transactions, conflicts };
}

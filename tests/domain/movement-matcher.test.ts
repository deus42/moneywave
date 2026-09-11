import { describe, expect, it } from "vitest";

import { buildMovementResolution, mergeCanonicalEvidence, type MatchObservation } from "@/domain/movement-matcher";

function observation(overrides: Partial<MatchObservation> & Pick<MatchObservation, "id" | "direction" | "amountMinor" | "accountId">): MatchObservation {
  return {
    sourceRecordId: `source-${overrides.id}`,
    provider: "privatbank",
    currency: "UAH",
    occurredAt: "2099-01-01T10:00:00.000Z",
    ...overrides,
  };
}

describe("movement matcher", () => {
  it("auto-confirms only provider/reference, same-row, or reciprocal-account evidence", () => {
    const observations = [
      observation({ id: "ref-out", accountId: "fop", direction: "debit", amountMinor: -10_000n, providerReference: "SYNTH-REF-1" }),
      observation({ id: "ref-in", accountId: "personal", direction: "credit", amountMinor: 10_000n, providerReference: "SYNTH-REF-1" }),
      observation({ id: "row-out", accountId: "fop", direction: "debit", amountMinor: -2_000n, sourceRecordId: "source-both" }),
      observation({ id: "row-in", accountId: "personal", direction: "credit", amountMinor: 2_000n, sourceRecordId: "source-both" }),
      observation({ id: "reciprocal-out", accountId: "a", direction: "debit", amountMinor: -3_000n, ownIdentifierHash: "HASH-A", counterpartyIdentifierHash: "HASH-B" }),
      observation({ id: "reciprocal-in", accountId: "b", direction: "credit", amountMinor: 3_000n, ownIdentifierHash: "HASH-B", counterpartyIdentifierHash: "HASH-A" }),
    ];

    const result = buildMovementResolution(observations);
    expect(result.confirmedGroups).toHaveLength(3);
    expect(result.confirmedGroups.map((group) => group.evidenceKind).sort()).toEqual([
      "provider_reference",
      "reciprocal_accounts",
      "same_source_record",
    ]);
    expect(result.candidates).toHaveLength(0);
  });

  it("keeps exact date/amount, near amount, and cross-currency pairs as review candidates", () => {
    const observations = [
      observation({ id: "exact-out", accountId: "a", direction: "debit", amountMinor: -10_000n }),
      observation({ id: "exact-in", accountId: "b", direction: "credit", amountMinor: 10_000n }),
      observation({ id: "near-out", accountId: "c", direction: "debit", amountMinor: -20_000n, occurredAt: "2099-01-02T10:00:00.000Z" }),
      observation({ id: "near-in", accountId: "d", direction: "credit", amountMinor: 19_900n, occurredAt: "2099-01-02T10:00:00.000Z" }),
      observation({ id: "fx-out", accountId: "e", direction: "debit", amountMinor: -10_000n, currency: "USD", occurredAt: "2099-01-03T10:00:00.000Z" }),
      observation({ id: "fx-in", accountId: "f", direction: "credit", amountMinor: 400_000n, currency: "UAH", occurredAt: "2099-01-03T10:00:00.000Z" }),
    ];
    const result = buildMovementResolution(observations);

    expect(result.confirmedGroups).toHaveLength(0);
    expect(result.candidates.map((candidate) => candidate.matchKind).sort()).toEqual(["cross_currency", "exact", "near_amount"]);
  });

  it("uses every evidence record attached to a canonical entry when proving the movement", () => {
    const result = buildMovementResolution([
      observation({
        id: "fop-out",
        accountId: "fop",
        direction: "debit",
        amountMinor: -10_000n,
        sourceRecordId: "fop-row",
        sourceRecordIds: ["fop-row"],
      }),
      observation({
        id: "personal-in",
        accountId: "personal",
        direction: "credit",
        amountMinor: 10_000n,
        sourceRecordId: "personal-row",
        sourceRecordIds: ["personal-row", "fop-row"],
      }),
    ]);

    expect(result.confirmedGroups).toEqual([
      expect.objectContaining({ evidenceKind: "same_source_record", observationIds: ["fop-out", "personal-in"] }),
    ]);
  });

  it("merges agreeing evidence but creates a conflict instead of overwriting disagreements", () => {
    const agreeing = [
      observation({ id: "one", accountId: "personal", direction: "credit", amountMinor: 10_000n, providerReference: "SYNTH-REF-9" }),
      observation({ id: "two", accountId: "personal", direction: "credit", amountMinor: 10_000n, providerReference: "SYNTH-REF-9" }),
    ];
    const conflict = observation({ id: "three", accountId: "personal", direction: "credit", amountMinor: 9_999n, providerReference: "SYNTH-REF-9" });
    const directionConflict = observation({ id: "four", accountId: "personal", direction: "debit", amountMinor: -10_000n, providerReference: "SYNTH-REF-9" });

    expect(mergeCanonicalEvidence(agreeing)).toMatchObject({ transactions: [{ evidenceIds: ["one", "two"] }], conflicts: [] });
    const result = mergeCanonicalEvidence([...agreeing, conflict, directionConflict]);
    expect(result.transactions[0]?.evidenceIds).toEqual(["one", "two"]);
    expect(result.conflicts).toEqual([
      expect.objectContaining({ reasonCode: "SOURCE_OBSERVATION_CONFLICT", evidenceId: "three" }),
      expect.objectContaining({ reasonCode: "SOURCE_OBSERVATION_CONFLICT", evidenceId: "four" }),
    ]);
  });
});

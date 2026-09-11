import { describe, expect, it } from "vitest";

import {
  resolveAutonomousMovements,
  type AutonomousMatchObservation,
} from "@/domain/autonomous-matcher";

function observation(overrides: Partial<AutonomousMatchObservation> & Pick<AutonomousMatchObservation, "id" | "direction" | "amountMinor">): AutonomousMatchObservation {
  return {
    accountId: overrides.direction === "debit" ? `account-out-${overrides.id}` : `account-in-${overrides.id}`,
    provider: "synthetic",
    ownerScope: "PERSONAL",
    currency: "UAH",
    occurredAt: "2099-02-03T10:00:00.000Z",
    transferSignal: true,
    fxSignal: false,
    sourceRecordIds: [`source-${overrides.id}`],
    providerReferences: [],
    identifierPairs: [],
    counterpartyAccountIds: [],
    sourceAmounts: [],
    ...overrides,
  };
}

describe("resolveAutonomousMovements", () => {
  it("uses a global one-to-one assignment instead of consuming the first acceptable credit", () => {
    const result = resolveAutonomousMovements([
      observation({ id: "debit-a", direction: "debit", amountMinor: -10_000n, occurredAt: "2099-02-03T10:00:00.000Z" }),
      observation({ id: "debit-b", direction: "debit", amountMinor: -10_000n, occurredAt: "2099-02-03T12:00:00.000Z" }),
      observation({ id: "credit-a", direction: "credit", amountMinor: 10_000n, occurredAt: "2099-02-03T10:02:00.000Z" }),
      observation({ id: "credit-b", direction: "credit", amountMinor: 10_000n, occurredAt: "2099-02-03T12:02:00.000Z" }),
    ], { uniquenessMargin: 0 });

    expect(result.matches.map(({ debitId, creditId }) => [debitId, creditId])).toEqual([
      ["debit-a", "credit-a"],
      ["debit-b", "credit-b"],
    ]);
  });

  it("auto-confirms a unique exact transfer with an explainable score", () => {
    const result = resolveAutonomousMovements([
      observation({ id: "debit", direction: "debit", amountMinor: -25_000n }),
      observation({ id: "credit", direction: "credit", amountMinor: 25_000n, occurredAt: "2099-02-03T10:05:00.000Z" }),
    ]);

    expect(result.matches).toEqual([
      expect.objectContaining({ debitId: "debit", creditId: "credit", matchKind: "exact", evidenceKind: "automatic_exact" }),
    ]);
    expect(result.matches[0]!.score).toBeGreaterThanOrEqual(100);
  });

  it("does not let a weaker cross-currency possibility block a unique exact transfer", () => {
    const result = resolveAutonomousMovements([
      observation({ id: "debit", direction: "debit", amountMinor: -25_000n }),
      observation({ id: "exact-credit", direction: "credit", amountMinor: 25_000n, occurredAt: "2099-02-03T10:05:00.000Z" }),
      observation({ id: "fx-credit", direction: "credit", amountMinor: 600n, currency: "EUR", occurredAt: "2099-02-03T10:01:00.000Z" }),
    ], {
      fxBenchmarkRate: ({ base, quote }) => base === "UAH" && quote === "EUR" ? "0.024" : null,
    });

    expect(result.matches).toEqual([
      expect.objectContaining({ debitId: "debit", creditId: "exact-credit", matchKind: "exact" }),
    ]);
  });

  it("does not turn an unrelated exact debit and credit into a transfer without movement evidence", () => {
    const result = resolveAutonomousMovements([
      observation({ id: "purchase", direction: "debit", amountMinor: -25_000n, transferSignal: false }),
      observation({ id: "refund", direction: "credit", amountMinor: 25_000n, transferSignal: false, occurredAt: "2099-02-03T10:05:00.000Z" }),
    ]);

    expect(result.matches).toEqual([]);
  });

  it("accepts a unique cross-provider exact pair when one side carries a transfer signal", () => {
    const result = resolveAutonomousMovements([
      observation({ id: "privat-out", provider: "privatbank", direction: "debit", amountMinor: -25_000n }),
      observation({
        id: "mono-in",
        provider: "monobank",
        direction: "credit",
        amountMinor: 25_000n,
        transferSignal: false,
        occurredAt: "2099-02-03T10:05:00.000Z",
      }),
    ]);

    expect(result.matches).toEqual([
      expect.objectContaining({ debitId: "privat-out", creditId: "mono-in", evidenceKind: "automatic_exact" }),
    ]);
  });

  it("accepts one-sided transfer evidence for an exact pair inside one provider within five minutes", () => {
    const result = resolveAutonomousMovements([
      observation({ id: "out", direction: "debit", amountMinor: -25_000n }),
      observation({ id: "in", direction: "credit", amountMinor: 25_000n, transferSignal: false, occurredAt: "2099-02-03T10:05:00.000Z" }),
    ]);

    expect(result.matches).toEqual([
      expect.objectContaining({ debitId: "out", creditId: "in", evidenceKind: "automatic_exact" }),
    ]);
  });

  it("does not use one-sided transfer evidence inside one provider after five minutes", () => {
    const result = resolveAutonomousMovements([
      observation({ id: "out", direction: "debit", amountMinor: -25_000n }),
      observation({ id: "in", direction: "credit", amountMinor: 25_000n, transferSignal: false, occurredAt: "2099-02-03T10:06:00.000Z" }),
    ]);

    expect(result.matches).toEqual([]);
  });

  it("does not force an ambiguous equal-score match", () => {
    const result = resolveAutonomousMovements([
      observation({ id: "debit", direction: "debit", amountMinor: -15_000n }),
      observation({ id: "credit-a", direction: "credit", amountMinor: 15_000n }),
      observation({ id: "credit-b", direction: "credit", amountMinor: 15_000n }),
    ]);

    expect(result.matches).toEqual([]);
    expect(result.ambiguousObservationIds).toContain("debit");
  });

  it("uses an exact provider timestamp to disambiguate otherwise identical transfers", () => {
    const result = resolveAutonomousMovements([
      observation({
        id: "debit-exact",
        provider: "monobank",
        direction: "debit",
        amountMinor: -50_000n,
        occurredAt: "2099-02-03T10:00:00.000Z",
      }),
      observation({
        id: "debit-thirteen-seconds-later",
        provider: "monobank",
        direction: "debit",
        amountMinor: -50_000n,
        occurredAt: "2099-02-03T10:00:13.000Z",
      }),
      observation({
        id: "credit",
        provider: "monobank",
        direction: "credit",
        amountMinor: 50_000n,
        transferSignal: false,
        occurredAt: "2099-02-03T10:00:00.000Z",
      }),
    ]);

    expect(result.matches).toEqual([
      expect.objectContaining({ debitId: "debit-exact", creditId: "credit" }),
    ]);
    expect(result.ambiguousObservationIds).not.toContain("credit");
  });

  it("accepts a unique near-amount transfer and reports the exact residual", () => {
    const result = resolveAutonomousMovements([
      observation({ id: "debit", direction: "debit", amountMinor: -100_000n }),
      observation({ id: "credit", direction: "credit", amountMinor: 99_000n, occurredAt: "2099-02-03T10:03:00.000Z" }),
    ]);

    expect(result.matches).toEqual([
      expect.objectContaining({
        debitId: "debit",
        creditId: "credit",
        matchKind: "near_amount",
        evidenceKind: "automatic_near",
        residualMinor: 1_000n,
      }),
    ]);
  });

  it("requires transfer evidence for a near-amount pair", () => {
    const result = resolveAutonomousMovements([
      observation({ id: "debit", direction: "debit", amountMinor: -100_000n, transferSignal: false }),
      observation({ id: "credit", direction: "credit", amountMinor: 99_000n, transferSignal: false }),
    ]);

    expect(result.matches).toEqual([]);
  });

  it("accepts a unique near-amount cross-provider pair with one transfer signal inside five minutes", () => {
    const result = resolveAutonomousMovements([
      observation({ id: "privat-out", provider: "privatbank", direction: "debit", amountMinor: -100_000n }),
      observation({
        id: "mono-in",
        provider: "monobank",
        direction: "credit",
        amountMinor: 99_500n,
        transferSignal: false,
        occurredAt: "2099-02-03T10:03:00.000Z",
      }),
    ]);

    expect(result.matches).toEqual([
      expect.objectContaining({
        debitId: "privat-out",
        creditId: "mono-in",
        matchKind: "near_amount",
        residualMinor: 500n,
      }),
    ]);
  });

  it("does not accept one-sided near-amount evidence after five minutes", () => {
    const result = resolveAutonomousMovements([
      observation({ id: "privat-out", provider: "privatbank", direction: "debit", amountMinor: -100_000n }),
      observation({
        id: "mono-in",
        provider: "monobank",
        direction: "credit",
        amountMinor: 99_500n,
        transferSignal: false,
        occurredAt: "2099-02-03T10:06:00.000Z",
      }),
    ]);

    expect(result.matches).toEqual([]);
  });

  it("accepts cross-currency only with FX or strong shared-source evidence", () => {
    const accepted = resolveAutonomousMovements([
      observation({ id: "usd-out", direction: "debit", amountMinor: -10_000n, currency: "USD", ownerScope: "SOLE_PROPRIETOR", fxSignal: true }),
      observation({ id: "uah-in", direction: "credit", amountMinor: 400_000n, currency: "UAH", ownerScope: "SOLE_PROPRIETOR", fxSignal: true }),
    ], { fxBenchmarkRate: () => "40" });
    const rejected = resolveAutonomousMovements([
      observation({ id: "usd-out", direction: "debit", amountMinor: -10_000n, currency: "USD", transferSignal: false }),
      observation({ id: "uah-in", direction: "credit", amountMinor: 400_000n, currency: "UAH", transferSignal: false }),
    ]);

    expect(accepted.matches).toEqual([
      expect.objectContaining({ debitId: "usd-out", creditId: "uah-in", matchKind: "cross_currency", evidenceKind: "automatic_fx" }),
    ]);
    expect(rejected.matches).toEqual([]);
  });

  it("rejects an automatic cross-currency pair whose implied rate is not plausible", () => {
    const result = resolveAutonomousMovements([
      observation({ id: "uah-out", direction: "debit", amountMinor: -100_000n, currency: "UAH" }),
      observation({ id: "eur-in", direction: "credit", amountMinor: 10_000n, currency: "EUR", occurredAt: "2099-02-03T10:01:00.000Z" }),
    ], { fxBenchmarkRate: () => "0.024" });

    expect(result.matches).toEqual([]);
  });

  it("uses a private account hint as strong evidence without exposing the identifier", () => {
    const result = resolveAutonomousMovements([
      observation({ id: "debit", accountId: "account-a", direction: "debit", amountMinor: -25_000n, counterpartyAccountIds: ["account-b"] }),
      observation({ id: "credit", accountId: "account-b", direction: "credit", amountMinor: 25_000n, transferSignal: false }),
    ]);

    expect(result.matches).toEqual([
      expect.objectContaining({ evidenceKind: "account_hint", matchKind: "exact" }),
    ]);
  });

  it("treats a cross-currency shared source row as hard evidence", () => {
    const result = resolveAutonomousMovements([
      observation({ id: "sell", direction: "debit", amountMinor: -20_000n, currency: "USD", sourceRecordIds: ["shared"], transferSignal: false }),
      observation({ id: "buy", direction: "credit", amountMinor: 800_000n, currency: "UAH", sourceRecordIds: ["shared"], transferSignal: false }),
    ]);

    expect(result.matches).toEqual([
      expect.objectContaining({ evidenceKind: "same_source_record", matchKind: "cross_currency" }),
    ]);
  });

  it("uses a provider-reported source amount to link a same-provider FX pair", () => {
    const result = resolveAutonomousMovements([
      observation({
        id: "uah-out",
        direction: "debit",
        amountMinor: -100_000n,
        currency: "UAH",
        transferSignal: false,
      }),
      observation({
        id: "eur-in",
        direction: "credit",
        amountMinor: 2_400n,
        currency: "EUR",
        transferSignal: false,
        sourceAmounts: [{ amountMinor: 100_000n, currency: "UAH" }],
        occurredAt: "2099-02-03T10:02:00.000Z",
      }),
    ]);

    expect(result.matches).toEqual([
      expect.objectContaining({ debitId: "uah-out", creditId: "eur-in", evidenceKind: "provider_source_amount", matchKind: "cross_currency" }),
    ]);
  });

  it("does not use provider source amount evidence after five minutes", () => {
    const result = resolveAutonomousMovements([
      observation({ id: "uah-out", direction: "debit", amountMinor: -100_000n, currency: "UAH", transferSignal: false }),
      observation({
        id: "eur-in",
        direction: "credit",
        amountMinor: 2_400n,
        currency: "EUR",
        transferSignal: false,
        sourceAmounts: [{ amountMinor: 100_000n, currency: "UAH" }],
        occurredAt: "2099-02-03T10:06:00.000Z",
      }),
    ]);

    expect(result.matches).toEqual([]);
  });

  it("prefers reciprocal provider source amounts over a one-way competing FX edge", () => {
    const result = resolveAutonomousMovements([
      observation({
        id: "reciprocal-uah-out",
        direction: "debit",
        amountMinor: -100_000n,
        currency: "UAH",
        transferSignal: false,
        sourceAmounts: [{ amountMinor: 2_400n, currency: "EUR" }],
      }),
      observation({
        id: "one-way-uah-out",
        direction: "debit",
        amountMinor: -100_000n,
        currency: "UAH",
        transferSignal: false,
      }),
      observation({
        id: "eur-in",
        direction: "credit",
        amountMinor: 2_400n,
        currency: "EUR",
        transferSignal: false,
        sourceAmounts: [{ amountMinor: 100_000n, currency: "UAH" }],
      }),
    ]);

    expect(result.matches).toEqual([
      expect.objectContaining({ debitId: "reciprocal-uah-out", creditId: "eur-in", evidenceKind: "provider_source_amount" }),
    ]);
  });

  it("is deterministic regardless of input order", () => {
    const input = [
      observation({ id: "debit-b", direction: "debit", amountMinor: -20_000n, occurredAt: "2099-02-04T11:00:00.000Z" }),
      observation({ id: "credit-a", direction: "credit", amountMinor: 10_000n, occurredAt: "2099-02-03T10:01:00.000Z" }),
      observation({ id: "debit-a", direction: "debit", amountMinor: -10_000n, occurredAt: "2099-02-03T10:00:00.000Z" }),
      observation({ id: "credit-b", direction: "credit", amountMinor: 20_000n, occurredAt: "2099-02-04T11:01:00.000Z" }),
    ];
    const first = resolveAutonomousMovements(input);
    const second = resolveAutonomousMovements([...input].reverse());

    expect(second).toEqual(first);
  });

  it("solves a sparse graph without padding the assignment matrix with unrelated entries", () => {
    const unrelated = Array.from({ length: 2_000 }, (_, index) => observation({
      id: `unrelated-${index}`,
      direction: "debit",
      amountMinor: -BigInt(1_000_000 + index),
      transferSignal: false,
    }));
    const result = resolveAutonomousMovements([
      ...unrelated,
      observation({ id: "matched-debit", direction: "debit", amountMinor: -25_000n }),
      observation({ id: "matched-credit", direction: "credit", amountMinor: 25_000n }),
    ]);

    expect(result.matches).toEqual([
      expect.objectContaining({ debitId: "matched-debit", creditId: "matched-credit" }),
    ]);
  }, 1_000);
});

it('matches an exact cross-provider statement transfer with date-only counter-evidence when both sides signal a transfer', () => {
  const result = resolveAutonomousMovements([
    observation({id:'synthetic-wise-out',provider:'wise',direction:'debit',amountMinor:-12345n,occurredAt:'2099-02-03T16:00:00'}),
    observation({id:'synthetic-bank-in',provider:'erste',direction:'credit',amountMinor:12345n,occurredAt:'2099-02-03T00:00:00'}),
  ]);
  expect(result.matches).toHaveLength(1);
});

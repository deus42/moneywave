import { randomUUID } from "node:crypto";

import Decimal from "decimal.js";

import {
  resolveAutonomousMovements,
  type AutonomousEvidenceKind,
  type FxBenchmarkRateInput,
  type AutonomousMatchObservation,
  type AutonomousMovementMatch,
} from "@/domain/autonomous-matcher";
import type { EncryptedDatabase } from "@/server/db/database";
import type { OwnerScope } from "@/server/import/types";
import { hasExternalAccountTransferSignal, hasFxSignal, hasMerchantFxPaymentSignal, hasMobileTopUpSignal, hasOwnTransferSignal, hasTransferSignal } from "@/domain/transaction-signals";
import type { OfficialFxRate } from "@/domain/fx-service";
import { currencyMinorDigits } from "@/domain/money";

interface LedgerRow {
  id: string;
  accountId: string;
  amountMinor: string;
  currency: string;
  direction: "debit" | "credit";
  occurredAt: string;
  entryKind: string;
  description: string | null;
  provider: string;
  ownerScope: OwnerScope;
  sourceCategory: string | null;
}

interface EvidenceRow {
  entryId: string;
  sourceRecordId: string;
  providerReference: string | null;
  ownIdentifierHash: string | null;
  counterpartyIdentifierHash: string | null;
  sourceAmountMinor: string | null;
  sourceCurrency: string | null;
}

interface PendingCandidateRow {
  id: string;
  debitEntryId: string;
  creditEntryId: string;
}

interface AccountInstrumentRow {
  accountId: string;
  maskedDisplay: string;
}

interface BenchmarkResolver {
  benchmark(input: FxBenchmarkRateInput): Promise<OfficialFxRate>;
}

type MovementLegKind = "fx_sell" | "fx_buy" | "transfer_out" | "transfer_in" | "owner_draw";

function movementSignals(row: LedgerRow): { transferSignal: boolean; fxSignal: boolean } {
  const searchable = `${row.sourceCategory ?? ""} ${row.description ?? ""}`.normalize("NFKC");
  return {
    transferSignal: !hasMobileTopUpSignal(searchable)
      && (hasTransferSignal(searchable) || hasExternalAccountTransferSignal(searchable)),
    fxSignal: hasFxSignal(searchable) && !hasMerchantFxPaymentSignal(searchable),
  };
}

function isUnresolvedMovementBoundary(row: LedgerRow): boolean {
  if (row.entryKind === "unlinked_transfer_in" || row.entryKind === "unlinked_transfer_out") return true;
  const searchable = `${row.sourceCategory ?? ""} ${row.description ?? ""}`.normalize("NFKC");
  return hasOwnTransferSignal(searchable)
    || hasExternalAccountTransferSignal(searchable)
    || (hasFxSignal(searchable) && !hasMerchantFxPaymentSignal(searchable));
}

function privateAccountHints(
  rows: readonly LedgerRow[],
  instruments: readonly AccountInstrumentRow[],
): Map<string, string[]> {
  const candidatesBySuffix = new Map<string, Set<string>>();
  for (const instrument of instruments) {
    const matches = instrument.maskedDisplay.match(/[0-9]{4}/g);
    const suffix = matches?.at(-1);
    if (!suffix) continue;
    const accounts = candidatesBySuffix.get(suffix) ?? new Set<string>();
    accounts.add(instrument.accountId);
    candidatesBySuffix.set(suffix, accounts);
  }
  const uniqueAccountBySuffix = new Map(
    [...candidatesBySuffix.entries()]
      .filter(([, accounts]) => accounts.size === 1)
      .map(([suffix, accounts]) => [suffix, [...accounts][0]!] as const),
  );
  const hints = new Map<string, string[]>();
  for (const row of rows) {
    const signals = movementSignals(row);
    if (!signals.transferSignal && !signals.fxSignal) continue;
    const tokens = row.description?.match(/[0-9]{4}/g) ?? [];
    const accounts = [...new Set(tokens.flatMap((token) => {
      const accountId = uniqueAccountBySuffix.get(token);
      return accountId && accountId !== row.accountId ? [accountId] : [];
    }))];
    if (accounts.length > 0) hints.set(row.id, accounts);
  }
  return hints;
}

function legKinds(debit: LedgerRow, credit: LedgerRow): [MovementLegKind, MovementLegKind] {
  if (debit.currency !== credit.currency) return ["fx_sell", "fx_buy"];
  if (debit.ownerScope === "SOLE_PROPRIETOR" && credit.ownerScope === "PERSONAL") return ["owner_draw", "transfer_in"];
  return ["transfer_out", "transfer_in"];
}

function pairKey(debitId: string, creditId: string): string {
  return `${debitId}:${creditId}`;
}

function scoreBand(match: AutonomousMovementMatch): "hard" | "high" {
  return ["provider_reference", "same_source_record", "provider_source_amount", "reciprocal_accounts", "account_hint"].includes(match.evidenceKind) ? "hard" : "high";
}

export interface AutonomousReconciliationResult {
  confirmed: number;
  rejectedCandidates: number;
  pendingCandidates: number;
  ambiguousEntries: number;
  unmatchedEntries: number;
  unexplainedGaps: number;
  fxConversions: number;
}

export class AutonomousReconciliationService {
  readonly #database: EncryptedDatabase;
  readonly #rates?: BenchmarkResolver;
  readonly #rateCache = new Map<string, string | null>();

  constructor(database: EncryptedDatabase, rates?: BenchmarkResolver) {
    this.#database = database;
    this.#rates = rates;
  }

  async run(): Promise<AutonomousReconciliationResult> {
    const [rows, evidence, pendingCandidates, instruments] = await Promise.all([
      this.#eligibleRows(),
      this.#evidence(),
      this.#database.all<PendingCandidateRow>(`
        SELECT id, debit_entry_id AS debitEntryId, credit_entry_id AS creditEntryId
        FROM movement_candidates
        WHERE status = 'pending'
        ORDER BY id
      `),
      this.#database.all<AccountInstrumentRow>(
        "SELECT account_id AS accountId, masked_display AS maskedDisplay FROM account_instruments ORDER BY rowid",
      ),
    ]);
    const accountHints = privateAccountHints(rows, instruments);
    const evidenceByEntry = new Map<string, EvidenceRow[]>();
    for (const item of evidence) {
      const entryEvidence = evidenceByEntry.get(item.entryId) ?? [];
      entryEvidence.push(item);
      evidenceByEntry.set(item.entryId, entryEvidence);
    }
    const observations: AutonomousMatchObservation[] = rows.map((row) => {
      const entryEvidence = evidenceByEntry.get(row.id) ?? [];
      const signals = movementSignals(row);
      return {
        id: row.id,
        accountId: row.accountId,
        provider: row.provider,
        ownerScope: row.ownerScope,
        direction: row.direction,
        amountMinor: BigInt(row.amountMinor),
        currency: row.currency,
        occurredAt: row.occurredAt,
        ...signals,
        sourceRecordIds: [...new Set(entryEvidence.map(({ sourceRecordId }) => sourceRecordId))],
        providerReferences: [...new Set(entryEvidence.flatMap(({ providerReference }) => providerReference ? [providerReference] : []))],
        sourceAmounts: entryEvidence.flatMap(({ sourceAmountMinor, sourceCurrency }) => (
          sourceAmountMinor !== null && sourceCurrency
            ? [{ amountMinor: BigInt(sourceAmountMinor), currency: sourceCurrency }]
            : []
        )),
        identifierPairs: entryEvidence.flatMap(({ ownIdentifierHash, counterpartyIdentifierHash }) => (
          ownIdentifierHash && counterpartyIdentifierHash
            ? [{ ownIdentifierHash, counterpartyIdentifierHash }]
            : []
        )),
        counterpartyAccountIds: accountHints.get(row.id) ?? [],
      };
    });
    await this.#loadFxRates(observations);
    const resolution = resolveAutonomousMovements(observations, {
      fxBenchmarkRate: (input) => this.#rateCache.get(this.#rateKey(input)) ?? null,
    });
    const rowById = new Map(rows.map((row) => [row.id, row]));
    const ambiguousIds = new Set(resolution.ambiguousObservationIds);
    const unmatchedMovementEntries = resolution.unmatchedObservationIds.filter((id) => {
      const row = rowById.get(id);
      return Boolean(
        ambiguousIds.has(id)
        || (row && isUnresolvedMovementBoundary(row))
      );
    }).length;
    const matchByPair = new Map(resolution.matches.map((match) => [pairKey(match.debitId, match.creditId), match]));
    let rejectedCandidates = 0;
    let unexplainedGaps = 0;
    let fxConversions = 0;

    await this.#database.transaction(async () => {
      for (const match of resolution.matches) {
        const debit = rowById.get(match.debitId);
        const credit = rowById.get(match.creditId);
        if (!debit || !credit) throw new Error("AUTOMATIC_MOVEMENT_ENTRY_NOT_FOUND");
        const groupId = await this.#insertGroup(debit, credit, match.evidenceKind);
        await this.#database.run(
          "UPDATE movement_candidates SET status = 'confirmed', reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE debit_entry_id = ? AND credit_entry_id = ?",
          [match.debitId, match.creditId],
        );
        if (match.matchKind === "near_amount" && match.residualMinor > 0n) {
          await this.#database.run(
            "INSERT INTO cost_components (id, movement_group_id, method, amount_minor, currency, estimated, audit_evidence_json) VALUES (?, ?, 'unexplained_gap', CAST(? AS INTEGER), ?, 0, ?)",
            [randomUUID(), groupId, match.residualMinor.toString(), debit.currency, JSON.stringify({ formulaVersion: "same_currency_v1" })],
          );
          unexplainedGaps += 1;
        }
        if (match.matchKind === "cross_currency") {
          const sold = -BigInt(debit.amountMinor);
          const received = BigInt(credit.amountMinor);
          const soldMajor = new Decimal(sold.toString()).div(new Decimal(10).pow(currencyMinorDigits(debit.currency)));
          const receivedMajor = new Decimal(received.toString()).div(new Decimal(10).pow(currencyMinorDigits(credit.currency)));
          const executedRate = receivedMajor.div(soldMajor).toSignificantDigits(24).toString();
          await this.#database.run(
            `INSERT INTO fx_conversions (
              id, movement_group_id, sold_amount_minor, sold_currency,
              received_amount_minor, received_currency, executed_rate_text, formula_version
            ) VALUES (?, ?, CAST(? AS INTEGER), ?, CAST(? AS INTEGER), ?, ?, 'executed_rate_v1')`,
            [randomUUID(), groupId, sold.toString(), debit.currency, received.toString(), credit.currency, executedRate],
          );
          fxConversions += 1;
        }
        await this.#database.run(
          "INSERT INTO audit_events (id, event_code, entity_type, entity_id, safe_details_json) VALUES (?, 'MOVEMENT_AUTOMATICALLY_CONFIRMED', 'movement_group', ?, ?)",
          [randomUUID(), groupId, JSON.stringify({ method: match.evidenceKind, scoreBand: scoreBand(match) })],
        );
      }

      for (const candidate of pendingCandidates) {
        const matched = matchByPair.has(pairKey(candidate.debitEntryId, candidate.creditEntryId));
        const status = matched ? "confirmed" : "rejected";
        const update = await this.#database.run(
          "UPDATE movement_candidates SET status = ?, reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND status = 'pending'",
          [status, candidate.id],
        );
        if (update.changes !== 1) continue;
        if (!matched) {
          rejectedCandidates += 1;
          await this.#database.run(
            "INSERT INTO audit_events (id, event_code, entity_type, entity_id, safe_details_json) VALUES (?, 'MOVEMENT_CANDIDATE_INSUFFICIENT_EVIDENCE', 'movement_candidate', ?, ?)",
            [randomUUID(), candidate.id, JSON.stringify({ reasonCode: "AMBIGUOUS_OR_WEAK_EVIDENCE" })],
          );
        }
      }
    });

    const pending = await this.#database.get<{ count: number }>(
      "SELECT count(*) AS count FROM movement_candidates WHERE status = 'pending'",
    );
    return {
      confirmed: resolution.matches.length,
      rejectedCandidates,
      pendingCandidates: pending?.count ?? 0,
      ambiguousEntries: resolution.ambiguousObservationIds.length,
      unmatchedEntries: unmatchedMovementEntries,
      unexplainedGaps,
      fxConversions,
    };
  }

  #rateKey(input: FxBenchmarkRateInput): string {
    return `${input.base}:${input.quote}:${input.onOrBeforeDate}`;
  }

  async #loadFxRates(observations: readonly AutonomousMatchObservation[]): Promise<void> {
    if (!this.#rates) return;
    const debits = observations.filter(({ direction }) => direction === "debit");
    const credits = observations.filter(({ direction }) => direction === "credit");
    const inputs = new Map<string, FxBenchmarkRateInput>();
    for (const debit of debits) {
      for (const credit of credits) {
        if (debit.accountId === credit.accountId || debit.currency === credit.currency) continue;
        if (!(debit.fxSignal || credit.fxSignal || (debit.transferSignal && credit.transferSignal))) continue;
        const minutes = Math.abs(Date.parse(debit.occurredAt) - Date.parse(credit.occurredAt)) / 60_000;
        if (!Number.isFinite(minutes) || minutes > 6 * 60) continue;
        const input = { base: debit.currency, quote: credit.currency, onOrBeforeDate: debit.occurredAt.slice(0, 10) };
        const key = this.#rateKey(input);
        if (!this.#rateCache.has(key)) inputs.set(key, input);
      }
    }
    for (const [key, input] of inputs) {
      try {
        this.#rateCache.set(key, (await this.#rates.benchmark(input)).rate);
      } catch {
        this.#rateCache.set(key, null);
      }
    }
  }

  async #insertGroup(debit: LedgerRow, credit: LedgerRow, evidenceKind: AutonomousEvidenceKind): Promise<string> {
    const existing = await this.#database.get<{ present: number }>(
      "SELECT 1 AS present FROM movement_legs WHERE ledger_entry_id IN (?, ?) LIMIT 1",
      [debit.id, credit.id],
    );
    if (existing) throw new Error("MOVEMENT_ENTRY_ALREADY_LINKED");
    const groupId = randomUUID();
    const [debitKind, creditKind] = legKinds(debit, credit);
    await this.#database.run(
      "DELETE FROM category_assignments WHERE ledger_entry_id IN (?, ?) AND method NOT IN ('manual', 'user_rule')",
      [debit.id, credit.id],
    );
    await this.#database.run(
      "INSERT INTO movement_groups (id, status, evidence_kind, confirmed_at) VALUES (?, 'confirmed', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
      [groupId, evidenceKind],
    );
    await this.#database.run(
      "INSERT INTO movement_legs (id, movement_group_id, ledger_entry_id, leg_kind, position) VALUES (?, ?, ?, ?, 0), (?, ?, ?, ?, 1)",
      [randomUUID(), groupId, debit.id, debitKind, randomUUID(), groupId, credit.id, creditKind],
    );
    await this.#database.run(
      "UPDATE ledger_entries SET reconciliation_status = 'confirmed', entry_kind = CASE id WHEN ? THEN ? WHEN ? THEN ? END WHERE id IN (?, ?)",
      [debit.id, debitKind, credit.id, creditKind, debit.id, credit.id],
    );
    return groupId;
  }

  async #eligibleRows(): Promise<LedgerRow[]> {
    return this.#database.all<LedgerRow>(`
      SELECT
        le.id,
        le.account_id AS accountId,
        CAST(le.amount_minor AS TEXT) AS amountMinor,
        le.currency,
        le.direction,
        le.occurred_at AS occurredAt,
        le.entry_kind AS entryKind,
        le.private_description AS description,
        p.code AS provider,
        a.owner_scope AS ownerScope,
        (
          SELECT COALESCE(json_extract(sr.source_metadata_json, '$.sourceCategory'), json_extract(sr.source_metadata_json, '$.statementCategory'))
          FROM transaction_evidence te
          JOIN source_records sr ON sr.id = te.source_record_id
          WHERE te.ledger_entry_id = le.id
          ORDER BY te.rowid
          LIMIT 1
        ) AS sourceCategory
      FROM ledger_entries le
      JOIN accounts a ON a.id = le.account_id
      JOIN providers p ON p.id = a.provider_id
      WHERE NOT EXISTS (SELECT 1 FROM movement_legs ml WHERE ml.ledger_entry_id = le.id)
      ORDER BY le.occurred_at, le.id
    `);
  }

  async #evidence(): Promise<EvidenceRow[]> {
    return this.#database.all<EvidenceRow>(`
      SELECT
        te.ledger_entry_id AS entryId,
        te.source_record_id AS sourceRecordId,
        te.provider_reference AS providerReference,
        te.own_identifier_hmac AS ownIdentifierHash,
        te.counterparty_identifier_hmac AS counterpartyIdentifierHash,
        CAST(te.source_amount_minor AS TEXT) AS sourceAmountMinor,
        te.source_currency AS sourceCurrency
      FROM transaction_evidence te
      JOIN ledger_entries le ON le.id = te.ledger_entry_id
      WHERE NOT EXISTS (SELECT 1 FROM movement_legs ml WHERE ml.ledger_entry_id = le.id)
      ORDER BY te.ledger_entry_id, te.rowid
    `);
  }
}

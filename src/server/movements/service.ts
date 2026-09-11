import { randomUUID } from "node:crypto";

import { buildMovementResolution, type LinkEvidenceKind, type MatchObservation } from "@/domain/movement-matcher";
import type { EncryptedDatabase } from "@/server/db/database";
import type { OwnerScope } from "@/server/import/types";

interface LedgerRow {
  id: string;
  accountId: string;
  amountMinorText: string;
  currency: string;
  direction: "debit" | "credit";
  occurredAt: string;
  provider: string;
  ownerScope: OwnerScope;
}

interface EvidenceRow {
  sourceRecordId: string;
  ownIdentifierHash: string | null;
  counterpartyIdentifierHash: string | null;
  providerReference: string | null;
}

type MovementLegKind = "fx_sell" | "fx_buy" | "transfer_out" | "transfer_in" | "owner_draw";

function legKinds(debit: LedgerRow, credit: LedgerRow): [MovementLegKind, MovementLegKind] {
  if (debit.currency !== credit.currency) return ["fx_sell", "fx_buy"];
  if (debit.ownerScope === "SOLE_PROPRIETOR" && credit.ownerScope === "PERSONAL") return ["owner_draw", "transfer_in"];
  return ["transfer_out", "transfer_in"];
}

export class MovementService {
  readonly #database: EncryptedDatabase;

  constructor(database: EncryptedDatabase) {
    this.#database = database;
  }

  async refresh(): Promise<{ confirmedCreated: number; candidatesCreated: number; unlinked: number }> {
    const ledgerRows = await this.#eligibleEntries();
    const rowById = new Map(ledgerRows.map((row) => [row.id, row]));
    const observations: MatchObservation[] = [];
    for (const row of ledgerRows) {
      const evidence = await this.#database.all<EvidenceRow>(
        "SELECT source_record_id AS sourceRecordId, own_identifier_hmac AS ownIdentifierHash, counterparty_identifier_hmac AS counterpartyIdentifierHash, provider_reference AS providerReference FROM transaction_evidence WHERE ledger_entry_id = ? ORDER BY rowid",
        [row.id],
      );
      const primary = evidence[0];
      if (!primary) continue;
      observations.push({
        id: row.id,
        sourceRecordId: primary.sourceRecordId,
        provider: row.provider,
        accountId: row.accountId,
        direction: row.direction,
        amountMinor: BigInt(row.amountMinorText),
        currency: row.currency,
        occurredAt: row.occurredAt,
        providerReference: evidence.find(({ providerReference }) => providerReference)?.providerReference ?? undefined,
        providerReferences: evidence.flatMap(({ providerReference }) => providerReference ? [providerReference] : []),
        sourceRecordIds: evidence.map(({ sourceRecordId }) => sourceRecordId),
        ownIdentifierHash: evidence.find(({ ownIdentifierHash }) => ownIdentifierHash)?.ownIdentifierHash ?? undefined,
        counterpartyIdentifierHash: evidence.find(({ counterpartyIdentifierHash }) => counterpartyIdentifierHash)?.counterpartyIdentifierHash ?? undefined,
        identifierPairs: evidence.flatMap(({ ownIdentifierHash, counterpartyIdentifierHash }) => (
          ownIdentifierHash && counterpartyIdentifierHash ? [{ ownIdentifierHash, counterpartyIdentifierHash }] : []
        )),
      });
    }

    const resolution = buildMovementResolution(observations);
    let confirmedCreated = 0;
    let candidatesCreated = 0;
    await this.#database.transaction(async () => {
      for (const group of resolution.confirmedGroups) {
        const debit = rowById.get(group.observationIds[0]);
        const credit = rowById.get(group.observationIds[1]);
        if (!debit || !credit) throw new Error("MOVEMENT_ENTRY_NOT_FOUND");
        await this.#insertGroup(debit, credit, group.evidenceKind);
        confirmedCreated += 1;
      }
      for (const candidate of resolution.candidates) {
        const result = await this.#database.run(
          "INSERT INTO movement_candidates (id, debit_entry_id, credit_entry_id, match_kind) VALUES (?, ?, ?, ?) ON CONFLICT(debit_entry_id, credit_entry_id) DO NOTHING",
          [candidate.id, candidate.observationIds[0], candidate.observationIds[1], candidate.matchKind],
        );
        candidatesCreated += result.changes;
      }
    });
    return { confirmedCreated, candidatesCreated, unlinked: resolution.unlinkedObservationIds.length };
  }

  async confirmCandidate(candidateId: string): Promise<{ groupId: string; evidenceKind: "manual"; status: "confirmed" }> {
    const candidate = await this.#database.get<{
      id: string;
      debitEntryId: string;
      creditEntryId: string;
      status: string;
    }>(
      "SELECT id, debit_entry_id AS debitEntryId, credit_entry_id AS creditEntryId, status FROM movement_candidates WHERE id = ?",
      [candidateId],
    );
    if (!candidate) throw new Error("MOVEMENT_CANDIDATE_NOT_FOUND");
    if (candidate.status !== "pending") throw new Error("MOVEMENT_CANDIDATE_ALREADY_REVIEWED");
    const rows = await this.#rowsByIds([candidate.debitEntryId, candidate.creditEntryId]);
    const debit = rows.find(({ id }) => id === candidate.debitEntryId);
    const credit = rows.find(({ id }) => id === candidate.creditEntryId);
    if (!debit || !credit) throw new Error("MOVEMENT_ENTRY_NOT_FOUND");

    let groupId = "";
    await this.#database.transaction(async () => {
      groupId = await this.#insertGroup(debit, credit, "manual");
      const candidateUpdate = await this.#database.run(
        "UPDATE movement_candidates SET status = 'confirmed', reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND status = 'pending'",
        [candidateId],
      );
      if (candidateUpdate.changes !== 1) throw new Error("MOVEMENT_CANDIDATE_NOT_PENDING");
      await this.#database.run(
        "INSERT INTO audit_events (id, event_code, entity_type, entity_id, safe_details_json) VALUES (?, 'MOVEMENT_CANDIDATE_CONFIRMED', 'movement_candidate', ?, '{}')",
        [randomUUID(), candidateId],
      );
    });
    return { groupId, evidenceKind: "manual", status: "confirmed" };
  }

  async rejectCandidate(candidateId: string): Promise<void> {
    await this.#database.transaction(async () => {
      const result = await this.#database.run(
        "UPDATE movement_candidates SET status = 'rejected', reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND status = 'pending'",
        [candidateId],
      );
      if (result.changes !== 1) throw new Error("MOVEMENT_CANDIDATE_NOT_PENDING");
      await this.#database.run(
        "INSERT INTO audit_events (id, event_code, entity_type, entity_id, safe_details_json) VALUES (?, 'MOVEMENT_CANDIDATE_REJECTED', 'movement_candidate', ?, '{}')",
        [randomUUID(), candidateId],
      );
    });
  }

  async attachExplicitFee(groupId: string, entryId: string): Promise<{ attached: true }> {
    await this.#database.transaction(async () => {
      const group = await this.#database.get<{ status: string; settlementCurrency: string | null }>(`
        SELECT
          mg.status,
          (
            SELECT le.currency
            FROM movement_legs ml
            JOIN ledger_entries le ON le.id = ml.ledger_entry_id
            WHERE ml.movement_group_id = mg.id AND le.direction = 'credit' AND ml.leg_kind <> 'explicit_fee'
            ORDER BY ml.position
            LIMIT 1
          ) AS settlementCurrency
        FROM movement_groups mg
        WHERE mg.id = ?
      `, [groupId]);
      if (!group) throw new Error("MOVEMENT_GROUP_NOT_FOUND");
      if (group.status !== "confirmed" || !group.settlementCurrency) throw new Error("MOVEMENT_GROUP_NOT_ATTACHABLE");
      const costAnalysis = await this.#database.get<{ present: number }>(
        "SELECT 1 AS present FROM cost_components WHERE movement_group_id = ? UNION SELECT 1 AS present FROM fx_conversions WHERE movement_group_id = ? LIMIT 1",
        [groupId, groupId],
      );
      if (costAnalysis) throw new Error("MOVEMENT_GROUP_COST_ALREADY_RECORDED");

      const entry = await this.#database.get<{
        direction: "debit" | "credit";
        entryKind: string;
        currency: string;
        reconciliationStatus: string;
        heldForReview: number;
      }>(`
        SELECT
          direction,
          entry_kind AS entryKind,
          currency,
          reconciliation_status AS reconciliationStatus,
          EXISTS (
            SELECT 1 FROM movement_candidates mc
            WHERE mc.status IN ('pending', 'confirmed')
              AND (mc.debit_entry_id = le.id OR mc.credit_entry_id = le.id)
          ) AS heldForReview
        FROM ledger_entries le
        WHERE le.id = ?
      `, [entryId]);
      if (!entry) throw new Error("MOVEMENT_ENTRY_NOT_FOUND");
      if (entry.reconciliationStatus !== "unlinked" || await this.#isEntryLinked(entryId)) {
        throw new Error("MOVEMENT_ENTRY_ALREADY_LINKED");
      }
      if (entry.heldForReview === 1) throw new Error("MOVEMENT_ENTRY_HELD_FOR_REVIEW");
      if (entry.entryKind !== "explicit_fee" || entry.direction !== "debit") throw new Error("MOVEMENT_FEE_ENTRY_INVALID");
      if (entry.currency !== group.settlementCurrency) throw new Error("MOVEMENT_FEE_CURRENCY_INVALID");

      const position = await this.#database.get<{ nextPosition: number }>(
        "SELECT COALESCE(MAX(position), -1) + 1 AS nextPosition FROM movement_legs WHERE movement_group_id = ?",
        [groupId],
      );
      await this.#database.run(
        "INSERT INTO movement_legs (id, movement_group_id, ledger_entry_id, leg_kind, position) VALUES (?, ?, ?, 'explicit_fee', ?)",
        [randomUUID(), groupId, entryId, position?.nextPosition ?? 0],
      );
      const updated = await this.#database.run(
        "UPDATE ledger_entries SET reconciliation_status = 'confirmed' WHERE id = ? AND reconciliation_status = 'unlinked'",
        [entryId],
      );
      if (updated.changes !== 1) throw new Error("MOVEMENT_ENTRY_ALREADY_LINKED");
      await this.#database.run(
        "INSERT INTO audit_events (id, event_code, entity_type, entity_id, safe_details_json) VALUES (?, 'MOVEMENT_EXPLICIT_FEE_ATTACHED', 'movement_group', ?, ?)",
        [randomUUID(), groupId, JSON.stringify({ legCountAdded: 1 })],
      );
    });
    return { attached: true };
  }

  async #insertGroup(debit: LedgerRow, credit: LedgerRow, evidenceKind: LinkEvidenceKind): Promise<string> {
    const existing = await this.#database.get<{ present: number }>(
      "SELECT 1 AS present FROM movement_legs WHERE ledger_entry_id IN (?, ?) LIMIT 1",
      [debit.id, credit.id],
    );
    if (existing) throw new Error("MOVEMENT_ENTRY_ALREADY_LINKED");
    const groupId = randomUUID();
    const [debitKind, creditKind] = legKinds(debit, credit);
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

  async #isEntryLinked(entryId: string): Promise<boolean> {
    const existing = await this.#database.get<{ present: number }>(
      "SELECT 1 AS present FROM movement_legs WHERE ledger_entry_id = ? LIMIT 1",
      [entryId],
    );
    return existing?.present === 1;
  }

  async #eligibleEntries(): Promise<LedgerRow[]> {
    return this.#database.all<LedgerRow>(`
      SELECT
        le.id,
        le.account_id AS accountId,
        CAST(le.amount_minor AS TEXT) AS amountMinorText,
        le.currency,
        le.direction,
        le.occurred_at AS occurredAt,
        p.code AS provider,
        a.owner_scope AS ownerScope
      FROM ledger_entries le
      JOIN accounts a ON a.id = le.account_id
      JOIN providers p ON p.id = a.provider_id
      WHERE NOT EXISTS (SELECT 1 FROM movement_legs ml WHERE ml.ledger_entry_id = le.id)
        AND NOT EXISTS (
          SELECT 1 FROM movement_candidates mc
          WHERE mc.status IN ('pending', 'confirmed')
            AND (mc.debit_entry_id = le.id OR mc.credit_entry_id = le.id)
        )
      ORDER BY le.occurred_at, le.id
    `);
  }

  async #rowsByIds(ids: readonly [string, string]): Promise<LedgerRow[]> {
    return this.#database.all<LedgerRow>(`
      SELECT
        le.id,
        le.account_id AS accountId,
        CAST(le.amount_minor AS TEXT) AS amountMinorText,
        le.currency,
        le.direction,
        le.occurred_at AS occurredAt,
        p.code AS provider,
        a.owner_scope AS ownerScope
      FROM ledger_entries le
      JOIN accounts a ON a.id = le.account_id
      JOIN providers p ON p.id = a.provider_id
      WHERE le.id IN (?, ?)
    `, ids);
  }
}

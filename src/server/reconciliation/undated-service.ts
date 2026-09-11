import { randomUUID } from "node:crypto";

import type { EncryptedDatabase } from "@/server/db/database";

interface PendingObservationRow {
  id: string;
  sourceRecordId: string;
  batchId: string;
  position: number;
  accountId: string;
  instrumentId: string | null;
  amountMinorText: string;
  currency: string;
  direction: "debit" | "credit";
  ownIdentifierHash: string | null;
  counterpartyIdentifierHash: string | null;
  providerReference: string | null;
  description: string | null;
}

interface LedgerMatch {
  ledgerEntryId: string;
  occurredAt: string;
}

interface CopyableEvidenceRow {
  ledgerEntryId: string;
  amountMinorText: string;
  currency: string;
  direction: "debit" | "credit";
  ownIdentifierHash: string | null;
  counterpartyIdentifierHash: string | null;
  providerReference: string | null;
  sourceAmountMinorText: string | null;
  sourceCurrency: string | null;
  instrumentId: string | null;
}

type ResolutionKind = "statement_match" | "manual";

function validateLedgerTimestamp(value: string): string {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/);
  if (!match) throw new Error("IMPORT_DATE_INVALID");
  const [, year, month, day, hour, minute, second] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)));
  if (
    date.getUTCFullYear() !== Number(year)
    || date.getUTCMonth() !== Number(month) - 1
    || date.getUTCDate() !== Number(day)
    || date.getUTCHours() !== Number(hour)
    || date.getUTCMinutes() !== Number(minute)
    || date.getUTCSeconds() !== Number(second)
  ) {
    throw new Error("IMPORT_DATE_INVALID");
  }
  return value;
}

export class UndatedReconciliationService {
  readonly #database: EncryptedDatabase;

  constructor(database: EncryptedDatabase) {
    this.#database = database;
  }

  async refresh(): Promise<{ resolvedRows: number; ambiguousRows: number; pendingRows: number }> {
    let resolvedRows = await this.#resolveReadyDuplicates();
    const groups = this.#groupBySource(await this.#pendingObservations());
    let ambiguousRows = 0;
    let pendingRows = 0;

    for (const observations of groups.values()) {
      const preferredMatches = new Map<string, LedgerMatch>();
      let ambiguous = false;
      for (const observation of observations) {
        const matches = await this.#statementMatches(observation);
        if (matches.length > 1) {
          ambiguous = true;
          continue;
        }
        if (matches[0]) preferredMatches.set(observation.id, matches[0]);
      }
      const dates = new Set([...preferredMatches.values()].map(({ occurredAt }) => occurredAt));
      if (ambiguous || dates.size > 1) {
        await this.#markAmbiguous(observations[0]!.sourceRecordId);
        ambiguousRows += 1;
        continue;
      }
      const occurredAt = dates.values().next().value as string | undefined;
      if (!occurredAt) {
        pendingRows += 1;
        continue;
      }
      await this.#resolve(observations, occurredAt, "statement_match", preferredMatches);
      resolvedRows += 1;
    }

    return { resolvedRows, ambiguousRows, pendingRows };
  }

  async resolveManually(sourceRecordId: string, occurredAt: string): Promise<{
    resolvedRows: 1;
    canonicalEntriesCreated: number;
    evidenceMerged: number;
  }> {
    const observations = (await this.#pendingObservations(sourceRecordId));
    if (observations.length === 0) throw new Error("IMPORT_UNDATED_OBSERVATION_NOT_FOUND");
    const result = await this.#resolve(observations, validateLedgerTimestamp(occurredAt), "manual", new Map());
    return { resolvedRows: 1, ...result };
  }

  async #resolve(
    observations: readonly PendingObservationRow[],
    occurredAt: string,
    resolutionKind: ResolutionKind,
    preferredMatches: ReadonlyMap<string, LedgerMatch>,
  ): Promise<{ canonicalEntriesCreated: number; evidenceMerged: number }> {
    validateLedgerTimestamp(occurredAt);
    const sourceRecordId = observations[0]?.sourceRecordId;
    const batchId = observations[0]?.batchId;
    if (!sourceRecordId || !batchId || observations.some((observation) => observation.sourceRecordId !== sourceRecordId || observation.batchId !== batchId)) {
      throw new Error("IMPORT_UNDATED_GROUP_INVALID");
    }
    let canonicalEntriesCreated = 0;
    let evidenceMerged = 0;
    await this.#database.transaction(async () => {
      const source = await this.#database.get<{ state: string }>(
        "SELECT row_state AS state FROM source_records WHERE id = ?",
        [sourceRecordId],
      );
      if (source?.state !== "unresolved") throw new Error("IMPORT_UNDATED_OBSERVATION_NOT_PENDING");

      for (const observation of observations) {
        let ledgerEntryId = preferredMatches.get(observation.id)?.ledgerEntryId;
        if (!ledgerEntryId) {
          const exact = await this.#exactLedgerMatches(observation, occurredAt);
          if (exact.length > 1) throw new Error("IMPORT_DATE_MATCH_AMBIGUOUS");
          ledgerEntryId = exact[0]?.ledgerEntryId;
        }
        if (!ledgerEntryId) {
          ledgerEntryId = randomUUID();
          await this.#database.run(
            "INSERT INTO ledger_entries (id, account_id, amount_minor, currency, direction, occurred_at, entry_kind, private_description) VALUES (?, ?, CAST(? AS INTEGER), ?, ?, ?, 'unclassified', ?)",
            [ledgerEntryId, observation.accountId, observation.amountMinorText, observation.currency, observation.direction, occurredAt, observation.description],
          );
          canonicalEntriesCreated += 1;
        } else {
          evidenceMerged += 1;
        }
        await this.#database.run(
          `INSERT INTO transaction_evidence (
            id, ledger_entry_id, source_record_id, observed_amount_minor, observed_currency,
            observed_direction, own_identifier_hmac, counterparty_identifier_hmac,
            provider_reference, instrument_id
          ) VALUES (?, ?, ?, CAST(? AS INTEGER), ?, ?, ?, ?, ?, ?)`,
          [
            randomUUID(),
            ledgerEntryId,
            sourceRecordId,
            observation.amountMinorText,
            observation.currency,
            observation.direction,
            observation.ownIdentifierHash,
            observation.counterpartyIdentifierHash,
            observation.providerReference,
            observation.instrumentId,
          ],
        );
        const updated = await this.#database.run(
          `UPDATE unresolved_observations
           SET status = 'resolved', resolved_ledger_entry_id = ?, resolution_kind = ?,
               resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE id = ? AND status = 'pending'`,
          [ledgerEntryId, resolutionKind, observation.id],
        );
        if (updated.changes !== 1) throw new Error("IMPORT_UNDATED_OBSERVATION_NOT_PENDING");
      }

      const sourceUpdate = await this.#database.run(
        "UPDATE source_records SET row_state = 'posted', reason_code = ? WHERE id = ? AND row_state = 'unresolved'",
        [resolutionKind === "statement_match" ? "CONDUCTED_DATE_RESOLVED_FROM_STATEMENT" : "CONDUCTED_DATE_CONFIRMED_MANUALLY", sourceRecordId],
      );
      if (sourceUpdate.changes !== 1) throw new Error("IMPORT_UNDATED_OBSERVATION_NOT_PENDING");
      const batchUpdate = await this.#database.run(
        "UPDATE import_batches SET posted_count = posted_count + 1, unresolved_count = unresolved_count - 1 WHERE id = ? AND unresolved_count > 0",
        [batchId],
      );
      if (batchUpdate.changes !== 1) throw new Error("IMPORT_STATUS_PARTITION_INVALID");
      const duplicateRowsResolved = await this.#propagateResolvedDuplicates(sourceRecordId);
      await this.#database.run(
        "INSERT INTO audit_events (id, event_code, entity_type, entity_id, safe_details_json) VALUES (?, 'UNDATED_OBSERVATION_RESOLVED', 'source_record', ?, ?)",
        [randomUUID(), sourceRecordId, JSON.stringify({ resolutionKind, observationCount: observations.length, canonicalEntriesCreated, evidenceMerged, duplicateRowsResolved })],
      );
    });
    return { canonicalEntriesCreated, evidenceMerged };
  }

  async #propagateResolvedDuplicates(canonicalSourceRecordId: string): Promise<number> {
    const duplicates = await this.#database.all<{ sourceRecordId: string; batchId: string }>(`
      SELECT id AS sourceRecordId, batch_id AS batchId
      FROM source_records
      WHERE duplicate_of_source_record_id = ? AND row_state = 'unresolved'
      ORDER BY rowid
    `, [canonicalSourceRecordId]);
    if (duplicates.length === 0) return 0;
    const evidence = await this.#database.all<CopyableEvidenceRow>(`
      SELECT
        ledger_entry_id AS ledgerEntryId,
        CAST(observed_amount_minor AS TEXT) AS amountMinorText,
        observed_currency AS currency,
        observed_direction AS direction,
        own_identifier_hmac AS ownIdentifierHash,
        counterparty_identifier_hmac AS counterpartyIdentifierHash,
        provider_reference AS providerReference,
        CAST(source_amount_minor AS TEXT) AS sourceAmountMinorText,
        source_currency AS sourceCurrency,
        instrument_id AS instrumentId
      FROM transaction_evidence
      WHERE source_record_id = ?
      ORDER BY rowid
    `, [canonicalSourceRecordId]);
    if (evidence.length === 0) return 0;

    let resolved = 0;
    for (const duplicate of duplicates) {
      for (const observation of evidence) {
        await this.#database.run(
          `INSERT INTO transaction_evidence (
            id, ledger_entry_id, source_record_id, observed_amount_minor, observed_currency,
            observed_direction, own_identifier_hmac, counterparty_identifier_hmac,
            provider_reference, source_amount_minor, source_currency, instrument_id
          ) VALUES (?, ?, ?, CAST(? AS INTEGER), ?, ?, ?, ?, ?, CAST(? AS INTEGER), ?, ?)`,
          [
            randomUUID(),
            observation.ledgerEntryId,
            duplicate.sourceRecordId,
            observation.amountMinorText,
            observation.currency,
            observation.direction,
            observation.ownIdentifierHash,
            observation.counterpartyIdentifierHash,
            observation.providerReference,
            observation.sourceAmountMinorText,
            observation.sourceCurrency,
            observation.instrumentId,
          ],
        );
      }
      const sourceUpdate = await this.#database.run(
        "UPDATE source_records SET row_state = 'posted', reason_code = 'DUPLICATE_RESOLVED_WITH_CANONICAL' WHERE id = ? AND duplicate_of_source_record_id = ? AND row_state = 'unresolved'",
        [duplicate.sourceRecordId, canonicalSourceRecordId],
      );
      if (sourceUpdate.changes !== 1) throw new Error("IMPORT_UNDATED_DUPLICATE_STATE_INVALID");
      const batchUpdate = await this.#database.run(
        "UPDATE import_batches SET posted_count = posted_count + 1, unresolved_count = unresolved_count - 1 WHERE id = ? AND unresolved_count > 0",
        [duplicate.batchId],
      );
      if (batchUpdate.changes !== 1) throw new Error("IMPORT_STATUS_PARTITION_INVALID");
      await this.#database.run(
        "INSERT INTO audit_events (id, event_code, entity_type, entity_id, safe_details_json) VALUES (?, 'UNDATED_DUPLICATE_RESOLVED', 'source_record', ?, ?)",
        [randomUUID(), duplicate.sourceRecordId, JSON.stringify({ canonicalSourceRecordId, evidenceCount: evidence.length })],
      );
      resolved += 1;
    }
    return resolved;
  }

  async #resolveReadyDuplicates(): Promise<number> {
    const canonicalSources = await this.#database.all<{ sourceRecordId: string }>(`
      SELECT DISTINCT canonical.id AS sourceRecordId
      FROM source_records duplicate
      JOIN source_records canonical ON canonical.id = duplicate.duplicate_of_source_record_id
      WHERE duplicate.row_state = 'unresolved'
        AND canonical.row_state = 'posted'
        AND EXISTS (
          SELECT 1 FROM transaction_evidence te
          WHERE te.source_record_id = canonical.id
        )
      ORDER BY canonical.rowid
    `);
    let resolved = 0;
    for (const canonical of canonicalSources) {
      await this.#database.transaction(async () => {
        resolved += await this.#propagateResolvedDuplicates(canonical.sourceRecordId);
      });
    }
    return resolved;
  }

  async #markAmbiguous(sourceRecordId: string): Promise<void> {
    await this.#database.run(
      "UPDATE source_records SET reason_code = 'CONDUCTED_DATE_MATCH_AMBIGUOUS' WHERE id = ? AND row_state = 'unresolved'",
      [sourceRecordId],
    );
  }

  async #pendingObservations(sourceRecordId?: string): Promise<PendingObservationRow[]> {
    const where = sourceRecordId ? "AND uo.source_record_id = ?" : "";
    return this.#database.all<PendingObservationRow>(`
      SELECT
        uo.id,
        uo.source_record_id AS sourceRecordId,
        sr.batch_id AS batchId,
        uo.position,
        uo.account_id AS accountId,
        uo.instrument_id AS instrumentId,
        CAST(uo.amount_minor AS TEXT) AS amountMinorText,
        uo.currency,
        uo.direction,
        uo.own_identifier_hmac AS ownIdentifierHash,
        uo.counterparty_identifier_hmac AS counterpartyIdentifierHash,
        uo.provider_reference AS providerReference,
        uo.private_description AS description
      FROM unresolved_observations uo
      JOIN source_records sr ON sr.id = uo.source_record_id
      WHERE uo.status = 'pending' ${where}
      ORDER BY uo.source_record_id, uo.position
    `, sourceRecordId ? [sourceRecordId] : []);
  }

  #groupBySource(observations: readonly PendingObservationRow[]): Map<string, PendingObservationRow[]> {
    const groups = new Map<string, PendingObservationRow[]>();
    for (const observation of observations) {
      const group = groups.get(observation.sourceRecordId) ?? [];
      group.push(observation);
      groups.set(observation.sourceRecordId, group);
    }
    return groups;
  }

  async #statementMatches(observation: PendingObservationRow): Promise<LedgerMatch[]> {
    return this.#database.all<LedgerMatch>(`
      SELECT DISTINCT le.id AS ledgerEntryId, le.occurred_at AS occurredAt
      FROM ledger_entries le
      JOIN transaction_evidence te ON te.ledger_entry_id = le.id
      JOIN source_records sr ON sr.id = te.source_record_id
      JOIN import_batches ib ON ib.id = sr.batch_id
      JOIN import_artifacts ia ON ia.id = ib.artifact_id
      WHERE ia.parser_kind = 'privat_personal'
        AND le.account_id = ?
        AND le.amount_minor = CAST(? AS INTEGER)
        AND le.currency = ?
        AND le.direction = ?
        AND NOT EXISTS (
          SELECT 1 FROM reconciliation_conflicts rc
          WHERE rc.ledger_entry_id = le.id AND rc.status = 'open'
        )
      ORDER BY le.occurred_at, le.id
    `, [observation.accountId, observation.amountMinorText, observation.currency, observation.direction]);
  }

  async #exactLedgerMatches(observation: PendingObservationRow, occurredAt: string): Promise<LedgerMatch[]> {
    return this.#database.all<LedgerMatch>(
      "SELECT id AS ledgerEntryId, occurred_at AS occurredAt FROM ledger_entries WHERE account_id = ? AND amount_minor = CAST(? AS INTEGER) AND currency = ? AND direction = ? AND occurred_at = ? ORDER BY rowid",
      [observation.accountId, observation.amountMinorText, observation.currency, observation.direction, occurredAt],
    );
  }
}

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import type { EncryptedDatabase } from "@/server/db/database";
import type { NormalizationResult, NormalizedObservation, OwnerScope } from "./types";

export interface ImportAccountRegistration {
  /** Operator-confirmed identity only; binds atomically with the statement import. */
  manualPositionSeriesId?: string;
  accountId: string;
  displayName: string;
  ownerScope: OwnerScope;
  accountType: string;
  currency: string;
  identifierHash: string;
  identifierKind: "account" | "instrument";
  instrumentId?: string;
  instrumentIdentifierHash?: string;
  instrumentMaskedDisplay?: string;
  maskedDisplay: string;
}

export interface ImportArtifactInput {
  bytes: Buffer;
  sha256: string;
  parserKind: NormalizationResult["kind"];
  parserVersion: string;
}

interface ExistingSourceRecord {
  id: string;
  fingerprint: string;
  evidence: ExistingEvidence[];
}

interface ExistingEvidence {
  ledgerEntryId: string;
  accountId: string;
  amountMinorText: string;
  currency: string;
  direction: "debit" | "credit";
}

interface ExistingCanonicalObservation {
  ledgerEntryId: string;
}

interface ExistingReferenceObservation extends ExistingCanonicalObservation {
  amountMinorText: string;
  currency: string;
  direction: "debit" | "credit";
  occurredAt: string;
}

function observationIdentity(observation: {
  accountId: string;
  amountMinor: bigint;
  currency: string;
  direction: string;
  occurredAt: string;
}): string {
  return JSON.stringify([
    observation.accountId,
    observation.amountMinor.toString(),
    observation.currency,
    observation.direction,
    observation.occurredAt,
  ]);
}

function providerReferenceIdentity(observation: NormalizedObservation): string | null {
  if (!observation.providerReference) return null;
  return JSON.stringify([observation.provider, observation.accountId, observation.providerReference]);
}

function conflictingObservationFields(
  canonical: ExistingReferenceObservation,
  observation: NormalizedObservation,
): string[] {
  const fields: string[] = [];
  if (canonical.amountMinorText !== observation.amountMinor.toString()) fields.push("amount");
  if (canonical.currency !== observation.currency) fields.push("currency");
  if (canonical.direction !== observation.direction) fields.push("direction");
  if (canonical.occurredAt !== observation.occurredAt) fields.push("occurredAt");
  return fields;
}

function validateHash(hash: string): void {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("ARTIFACT_HASH_INVALID");
}

function countStates(normalization: NormalizationResult): {
  posted: number;
  nonPosted: number;
  unresolved: number;
  rejected: number;
} {
  return normalization.rows.reduce((counts, row) => {
    if (row.state === "posted") counts.posted += 1;
    else if (row.state === "non_posted") counts.nonPosted += 1;
    else if (row.state === "unresolved") counts.unresolved += 1;
    else if (row.state === "rejected") counts.rejected += 1;
    return counts;
  }, { posted: 0, nonPosted: 0, unresolved: 0, rejected: 0 });
}

export class ImportRepository {
  readonly #database: EncryptedDatabase;

  constructor(database: EncryptedDatabase) {
    this.#database = database;
  }

  async hasArtifact(sha256: string): Promise<boolean> {
    validateHash(sha256);
    const row = await this.#database.get<{ present: number }>("SELECT 1 AS present FROM import_artifacts WHERE sha256 = ?", [sha256]);
    return row?.present === 1;
  }

  async commitImport(input: {
    artifact: ImportArtifactInput;
    normalization: NormalizationResult;
    registrations: readonly ImportAccountRegistration[];
    provider: { code: string; displayName: string };
    reconciliationIssueCodes?: readonly string[];
  }): Promise<{
    batchId: string;
    artifactStored: true;
    canonicalEntriesCreated: number;
    evidenceMerged: number;
    conflictsCreated: number;
    rowCount: number;
    postedCount: number;
    nonPostedCount: number;
    unresolvedCount: number;
    rejectedCount: number;
  }> {
    validateHash(input.artifact.sha256);
    const actualHash = createHash("sha256").update(input.artifact.bytes).digest();
    const claimedHash = Buffer.from(input.artifact.sha256, "hex");
    if (actualHash.byteLength !== claimedHash.byteLength || !timingSafeEqual(actualHash, claimedHash)) {
      throw new Error("ARTIFACT_HASH_MISMATCH");
    }
    if (input.artifact.bytes.byteLength === 0) throw new Error("IMPORT_ARTIFACT_EMPTY");
    if (await this.hasArtifact(input.artifact.sha256)) throw new Error("ARTIFACT_ALREADY_IMPORTED");
    const reconciliationIssueCodes = [...new Set(input.reconciliationIssueCodes ?? [])].sort();
    if (reconciliationIssueCodes.some((code) => !/^[A-Z][A-Z0-9_]{2,80}$/.test(code))) {
      throw new Error("IMPORT_RECONCILIATION_ISSUE_INVALID");
    }
    if (!/^[a-z][a-z0-9_-]{1,63}$/.test(input.provider.code)) throw new Error("IMPORT_PROVIDER_CODE_INVALID");
    if (!input.provider.displayName.trim() || input.provider.displayName.length > 120) throw new Error("IMPORT_PROVIDER_NAME_INVALID");
    if (input.normalization.rows.some((row) => row.observations.some(({ provider }) => provider !== input.provider.code))) {
      throw new Error("IMPORT_PROVIDER_OBSERVATION_CONFLICT");
    }

    const stateCounts = countStates(input.normalization);
    const batchId = randomUUID();
    const artifactId = randomUUID();
    let canonicalEntriesCreated = 0;
    let evidenceMerged = 0;
    let conflictsCreated = 0;

    await this.#database.transaction(async () => {
      const providerId = `provider-${input.provider.code}`;
      await this.#database.run(
        "INSERT INTO providers (id, code, display_name) VALUES (?, ?, ?) ON CONFLICT(code) DO NOTHING",
        [providerId, input.provider.code, input.provider.displayName],
      );
      const persistedProvider = await this.#database.get<{ id: string; displayName: string }>(
        "SELECT id, display_name AS displayName FROM providers WHERE code = ?",
        [input.provider.code],
      );
      if (!persistedProvider || persistedProvider.id !== providerId || persistedProvider.displayName !== input.provider.displayName) {
        throw new Error("IMPORT_PROVIDER_CONFLICT");
      }
      await this.#registerAccounts(input.registrations, providerId);
      for (const registration of input.registrations) {
        if (!registration.manualPositionSeriesId) {
          const unbound = await this.#database.get<{ n: number }>(
            "SELECT COUNT(*) AS n FROM manual_position_series WHERE provider_code = ? AND currency = ? AND account_id IS NULL",
            [input.provider.code, registration.currency],
          );
          if (unbound?.n) throw new Error("MANUAL_EXISTING_POSITION_REQUIRES_BINDING");
          continue;
        }
        const series = await this.#database.get<{ account: string | null; provider: string; currency: string; kind: string }>(
          "SELECT account_id AS account, provider_code AS provider, currency, position_kind AS kind FROM manual_position_series WHERE id = ?",
          [registration.manualPositionSeriesId],
        );
        if (!series || series.provider !== input.provider.code || series.currency !== registration.currency
          || series.kind !== "bank" || registration.ownerScope !== "PERSONAL"
          || (series.account !== null && series.account !== registration.accountId)) {
          throw new Error("MANUAL_ACCOUNT_BINDING_CONFLICT");
        }
        if (series.account === null) {
          await this.#database.run("UPDATE manual_position_series SET account_id = ? WHERE id = ? AND account_id IS NULL", [registration.accountId, registration.manualPositionSeriesId]);
          await this.#database.run("INSERT INTO audit_events (id,event_code,entity_type,entity_id,safe_details_json) VALUES (?,'MANUAL_ACCOUNT_BOUND','manual_position_series',?,?)",
            [randomUUID(), registration.manualPositionSeriesId, JSON.stringify({ evidence: "user_confirmed_statement_binding" })]);
        }
      }
      await this.#database.run(
        "INSERT INTO import_artifacts (id, sha256, encrypted_bytes, size_bytes, parser_kind, parser_version) VALUES (?, ?, ?, ?, ?, ?)",
        [artifactId, input.artifact.sha256, input.artifact.bytes, input.artifact.bytes.byteLength, input.artifact.parserKind, input.artifact.parserVersion],
      );
      await this.#database.run(
        "INSERT INTO import_batches (id, artifact_id, status, row_count, posted_count, non_posted_count, unresolved_count, rejected_count, reconciliation_issues_json) VALUES (?, ?, 'preview', ?, ?, ?, ?, ?, ?)",
        [batchId, artifactId, input.normalization.rows.length, stateCounts.posted, stateCounts.nonPosted, stateCounts.unresolved, stateCounts.rejected, JSON.stringify(reconciliationIssueCodes)],
      );

      const existingByFingerprint = await this.#existingCanonicalSources(input.normalization.rows.map(({ dedupeFingerprint }) => dedupeFingerprint));
      const existingByObservation = await this.#existingCanonicalObservations(
        input.normalization.rows.flatMap(({ observations }) => observations),
      );
      const existingByProviderReference = await this.#existingProviderReferences(
        input.normalization.rows.flatMap(({ observations }) => observations),
      );
      const occurrence = new Map<string, number>();
      const observationOccurrence = new Map<string, number>();
      for (const row of input.normalization.rows) {
        const index = occurrence.get(row.dedupeFingerprint) ?? 0;
        occurrence.set(row.dedupeFingerprint, index + 1);
        const duplicate = existingByFingerprint.get(row.dedupeFingerprint)?.[index];
        const persistedSourceId = randomUUID();
        await this.#database.run(
          "INSERT INTO source_records (id, batch_id, source_row_number, dedupe_fingerprint, row_state, reason_code, duplicate_of_source_record_id, source_metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [
            persistedSourceId,
            batchId,
            row.sourceRowNumber,
            row.dedupeFingerprint,
            row.state,
            row.reasonCode ?? null,
            duplicate?.id ?? null,
            JSON.stringify(row.sourceMetadata),
          ],
        );

        if (duplicate) {
          for (const observation of row.observations) {
            const identity = observationIdentity(observation);
            observationOccurrence.set(identity, (observationOccurrence.get(identity) ?? 0) + 1);
            const match = duplicate.evidence.find((evidence) =>
              evidence.accountId === observation.accountId
              && evidence.amountMinorText === observation.amountMinor.toString()
              && evidence.currency === observation.currency
              && evidence.direction === observation.direction,
            );
            if (!match) throw new Error("OVERLAP_EVIDENCE_CONFLICT");
            await this.#insertEvidence(match.ledgerEntryId, persistedSourceId, observation);
            await this.#persistBalanceSnapshot(persistedSourceId, observation);
            evidenceMerged += 1;
          }
          continue;
        }

        const undatedObservations = row.undatedObservations ?? [];
        if (undatedObservations.length > 0) {
          if (row.state !== "unresolved" || row.observations.length > 0) throw new Error("IMPORT_UNDATED_STATE_INVALID");
          for (const [position, observation] of undatedObservations.entries()) {
            const instrumentId = await this.#canonicalInstrumentId(
              observation.accountId,
              observation.instrumentIdentifierHash ?? observation.ownIdentifierHash,
              observation.instrumentId,
            );
            await this.#database.run(
              `INSERT INTO unresolved_observations (
                id, source_record_id, position, account_id, instrument_id, amount_minor, currency,
                direction, own_identifier_hmac, counterparty_identifier_hmac, provider_reference,
                private_description
              ) VALUES (?, ?, ?, ?, ?, CAST(? AS INTEGER), ?, ?, ?, ?, ?, ?)`,
              [
                randomUUID(),
                persistedSourceId,
                position,
                observation.accountId,
                instrumentId,
                observation.amountMinor.toString(),
                observation.currency,
                observation.direction,
                observation.ownIdentifierHash,
                observation.counterpartyIdentifierHash ?? null,
                observation.providerReference ?? null,
                observation.description ?? null,
              ],
            );
          }
        }

        for (const observation of row.observations) {
          const referenceIdentity = providerReferenceIdentity(observation);
          if (referenceIdentity) {
            const referenceMatches = existingByProviderReference.get(referenceIdentity) ?? [];
            const canonicalByLedger = new Map(referenceMatches.map((match) => [match.ledgerEntryId, match]));
            if (canonicalByLedger.size > 1) {
              await this.#insertConflict(persistedSourceId, null, "PROVIDER_REFERENCE_AMBIGUOUS", ["providerReference"]);
              await this.#persistBalanceSnapshot(persistedSourceId, observation);
              conflictsCreated += 1;
              continue;
            }
            const canonical = canonicalByLedger.values().next().value as ExistingReferenceObservation | undefined;
            if (canonical) {
              const conflictFields = conflictingObservationFields(canonical, observation);
              await this.#insertEvidence(canonical.ledgerEntryId, persistedSourceId, observation);
              await this.#persistBalanceSnapshot(persistedSourceId, observation);
              evidenceMerged += 1;
              if (conflictFields.length > 0) {
                await this.#insertConflict(
                  persistedSourceId,
                  canonical.ledgerEntryId,
                  "SOURCE_OBSERVATION_CONFLICT",
                  conflictFields,
                );
                conflictsCreated += 1;
              }
              continue;
            }
          }
          const identity = observationIdentity(observation);
          const identityIndex = observationOccurrence.get(identity) ?? 0;
          observationOccurrence.set(identity, identityIndex + 1);
          const priorObservation = existingByObservation.get(identity)?.[identityIndex];
          if (priorObservation) {
            await this.#insertEvidence(priorObservation.ledgerEntryId, persistedSourceId, observation);
            await this.#persistBalanceSnapshot(persistedSourceId, observation);
            evidenceMerged += 1;
            if (referenceIdentity) {
              existingByProviderReference.set(referenceIdentity, [{
                ledgerEntryId: priorObservation.ledgerEntryId,
                amountMinorText: observation.amountMinor.toString(),
                currency: observation.currency,
                direction: observation.direction,
                occurredAt: observation.occurredAt,
              }]);
            }
            continue;
          }
          const ledgerEntryId = randomUUID();
          await this.#database.run(
            "INSERT INTO ledger_entries (id, account_id, amount_minor, currency, direction, occurred_at, entry_kind, private_description) VALUES (?, ?, CAST(? AS INTEGER), ?, ?, ?, ?, ?)",
            [ledgerEntryId, observation.accountId, observation.amountMinor.toString(), observation.currency, observation.direction, observation.occurredAt, "unclassified", observation.description ?? null],
          );
          await this.#insertEvidence(ledgerEntryId, persistedSourceId, observation);
          await this.#persistBalanceSnapshot(persistedSourceId, observation);
          canonicalEntriesCreated += 1;
          if (referenceIdentity) {
            existingByProviderReference.set(referenceIdentity, [{
              ledgerEntryId,
              amountMinorText: observation.amountMinor.toString(),
              currency: observation.currency,
              direction: observation.direction,
              occurredAt: observation.occurredAt,
            }]);
          }
        }
      }

      await this.#database.run(
        "UPDATE import_batches SET status = 'committed', committed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
        [batchId],
      );
      await this.#database.run(
        "INSERT INTO audit_events (id, event_code, entity_type, entity_id, safe_details_json) VALUES (?, ?, ?, ?, ?)",
        [randomUUID(), "IMPORT_COMMITTED", "import_batch", batchId, JSON.stringify({ rowCount: input.normalization.rows.length, postedCount: stateCounts.posted, nonPostedCount: stateCounts.nonPosted, unresolvedCount: stateCounts.unresolved, rejectedCount: stateCounts.rejected, reconciliationIssueCodes, canonicalEntriesCreated, evidenceMerged, conflictsCreated })],
      );
    });

    return {
      batchId,
      artifactStored: true,
      canonicalEntriesCreated,
      evidenceMerged,
      conflictsCreated,
      rowCount: input.normalization.rows.length,
      postedCount: stateCounts.posted,
      nonPostedCount: stateCounts.nonPosted,
      unresolvedCount: stateCounts.unresolved,
      rejectedCount: stateCounts.rejected,
    };
  }

  async #insertConflict(
    sourceRecordId: string,
    ledgerEntryId: string | null,
    reasonCode: string,
    fields: readonly string[],
  ): Promise<void> {
    await this.#database.run(
      "INSERT INTO reconciliation_conflicts (id, source_record_id, ledger_entry_id, reason_code, safe_details_json) VALUES (?, ?, ?, ?, ?)",
      [randomUUID(), sourceRecordId, ledgerEntryId, reasonCode, JSON.stringify({ fields })],
    );
  }

  async #insertEvidence(ledgerEntryId: string, sourceRecordId: string, observation: NormalizedObservation): Promise<void> {
    const instrumentId = await this.#canonicalInstrumentId(
      observation.accountId,
      observation.instrumentIdentifierHash ?? observation.ownIdentifierHash,
      observation.instrumentId,
    );
    if ((observation.explicitFeeMinor === undefined) !== (observation.explicitFeeCurrency === undefined)) {
      throw new Error("PROVIDER_FEE_INVALID");
    }
    if (
      observation.explicitFeeMinor !== undefined
      && (observation.explicitFeeMinor <= 0n || !/^[A-Z]{3,8}$/u.test(observation.explicitFeeCurrency ?? ""))
    ) {
      throw new Error("PROVIDER_FEE_INVALID");
    }
    const evidenceId = randomUUID();
    await this.#database.run(
      `INSERT INTO transaction_evidence (
        id, ledger_entry_id, source_record_id, observed_amount_minor, observed_currency,
        observed_direction, own_identifier_hmac, counterparty_identifier_hmac,
        provider_reference, source_amount_minor, source_currency, instrument_id
      ) VALUES (?, ?, ?, CAST(? AS INTEGER), ?, ?, ?, ?, ?, CAST(? AS INTEGER), ?, ?)`,
      [
        evidenceId,
        ledgerEntryId,
        sourceRecordId,
        observation.amountMinor.toString(),
        observation.currency,
        observation.direction,
        observation.ownIdentifierHash,
        observation.counterpartyIdentifierHash ?? null,
        observation.providerReference ?? null,
        observation.sourceAmountMinor?.toString() ?? null,
        observation.sourceCurrency ?? null,
        instrumentId,
      ],
    );
    if (observation.explicitFeeMinor !== undefined && observation.explicitFeeCurrency) {
      await this.#database.run(
        `INSERT INTO provider_fee_evidence (
          id, transaction_evidence_id, amount_minor, currency, included_in_settlement
        ) VALUES (?, ?, CAST(? AS INTEGER), ?, 1)`,
        [randomUUID(), evidenceId, observation.explicitFeeMinor.toString(), observation.explicitFeeCurrency],
      );
    }
  }

  async #canonicalInstrumentId(accountId: string, identifierHash: string, proposedId?: string): Promise<string | null> {
    if (!proposedId) return null;
    const bound = await this.#database.get<{ id: string; accountId: string }>(
      "SELECT id, account_id AS accountId FROM account_instruments WHERE identifier_hmac = ?",
      [identifierHash],
    );
    if (!bound || bound.accountId !== accountId) throw new Error("INSTRUMENT_MAPPING_CONFLICT");
    return bound.id;
  }

  async #persistBalanceSnapshot(sourceRecordId: string, observation: NormalizedObservation): Promise<void> {
    if (observation.resultingBalanceMinor === undefined || !observation.resultingBalanceCurrency) return;
    if (observation.resultingBalanceCurrency !== observation.currency) throw new Error("BALANCE_CURRENCY_CONFLICT");
    await this.#database.run(
      `INSERT INTO balance_snapshots (
        id, account_id, balance_minor, currency, observed_at, evidence_kind, source_record_id
      ) VALUES (?, ?, CAST(? AS INTEGER), ?, ?, 'statement', ?)`,
      [randomUUID(), observation.accountId, observation.resultingBalanceMinor.toString(), observation.currency, observation.occurredAt, sourceRecordId],
    );
    await this.#database.run(
      "UPDATE accounts SET balance_evidence_status = 'statement' WHERE id = ?",
      [observation.accountId],
    );
  }

  async #registerAccounts(registrations: readonly ImportAccountRegistration[], providerId: string): Promise<void> {
    for (const registration of registrations) {
      if (!/^[a-f0-9]{64}$/.test(registration.identifierHash)) throw new Error("ACCOUNT_IDENTIFIER_HASH_INVALID");
      const existing = await this.#database.get<{
        owner_scope: OwnerScope;
        currency: string;
        account_type: string;
        provider_id: string;
        identifier_hmac: string | null;
      }>("SELECT owner_scope, currency, account_type, provider_id, identifier_hmac FROM accounts WHERE id = ?", [registration.accountId]);
      if (existing) {
        if (existing.provider_id !== providerId) throw new Error("ACCOUNT_PROVIDER_CONFLICT");
        if (existing.owner_scope !== registration.ownerScope || existing.currency !== registration.currency || existing.account_type !== registration.accountType) {
          throw new Error("ACCOUNT_MAPPING_CONFLICT");
        }
        if (registration.identifierKind === "account") {
          if (existing.identifier_hmac && existing.identifier_hmac !== registration.identifierHash) {
            throw new Error("ACCOUNT_IDENTIFIER_CONFLICT");
          }
          const bound = await this.#database.get<{ id: string }>(
            "SELECT id FROM accounts WHERE identifier_hmac = ?",
            [registration.identifierHash],
          );
          if (bound && bound.id !== registration.accountId) throw new Error("ACCOUNT_IDENTIFIER_CONFLICT");
          if (!existing.identifier_hmac) {
            await this.#database.run(
              "UPDATE accounts SET identifier_hmac = ? WHERE id = ? AND identifier_hmac IS NULL",
              [registration.identifierHash, registration.accountId],
            );
          }
        }
      } else {
        await this.#database.run(
          "INSERT INTO accounts (id, provider_id, owner_scope, account_type, currency, display_name, identifier_hmac) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [registration.accountId, providerId, registration.ownerScope, registration.accountType, registration.currency, registration.displayName, registration.identifierKind === "account" ? registration.identifierHash : null],
        );
      }
      if (registration.identifierKind === "instrument") {
        if (!registration.instrumentId) throw new Error("INSTRUMENT_ID_REQUIRED");
        const bound = await this.#database.get<{ id: string; accountId: string }>(
          "SELECT id, account_id AS accountId FROM account_instruments WHERE identifier_hmac = ?",
          [registration.identifierHash],
        );
        if (bound && bound.accountId !== registration.accountId) throw new Error("INSTRUMENT_MAPPING_CONFLICT");
        const proposedId = await this.#database.get<{ identifierHash: string; accountId: string }>(
          "SELECT identifier_hmac AS identifierHash, account_id AS accountId FROM account_instruments WHERE id = ?",
          [registration.instrumentId],
        );
        if (proposedId && (proposedId.identifierHash !== registration.identifierHash || proposedId.accountId !== registration.accountId)) {
          throw new Error("INSTRUMENT_MAPPING_CONFLICT");
        }
        if (!bound) {
          await this.#database.run(
            "INSERT INTO account_instruments (id, account_id, instrument_kind, identifier_hmac, masked_display) VALUES (?, ?, ?, ?, ?)",
            [registration.instrumentId, registration.accountId, "card", registration.identifierHash, registration.maskedDisplay],
          );
        }
      }
      if (registration.identifierKind === "account" && registration.instrumentIdentifierHash) {
        if (!registration.instrumentId || !registration.instrumentMaskedDisplay) throw new Error("INSTRUMENT_ID_REQUIRED");
        if (!/^[a-f0-9]{64}$/.test(registration.instrumentIdentifierHash)) throw new Error("ACCOUNT_IDENTIFIER_HASH_INVALID");
        const bound = await this.#database.get<{ id: string; accountId: string }>(
          "SELECT id, account_id AS accountId FROM account_instruments WHERE identifier_hmac = ?",
          [registration.instrumentIdentifierHash],
        );
        if (bound && bound.accountId !== registration.accountId) throw new Error("INSTRUMENT_MAPPING_CONFLICT");
        const proposedId = await this.#database.get<{ identifierHash: string; accountId: string }>(
          "SELECT identifier_hmac AS identifierHash, account_id AS accountId FROM account_instruments WHERE id = ?",
          [registration.instrumentId],
        );
        if (proposedId && (
          proposedId.identifierHash !== registration.instrumentIdentifierHash
          || proposedId.accountId !== registration.accountId
        )) throw new Error("INSTRUMENT_MAPPING_CONFLICT");
        if (!bound) {
          await this.#database.run(
            "INSERT INTO account_instruments (id, account_id, instrument_kind, identifier_hmac, masked_display) VALUES (?, ?, 'card', ?, ?)",
            [registration.instrumentId, registration.accountId, registration.instrumentIdentifierHash, registration.instrumentMaskedDisplay],
          );
        }
      }
    }
  }

  async #existingCanonicalSources(fingerprints: readonly string[]): Promise<Map<string, ExistingSourceRecord[]>> {
    const unique = [...new Set(fingerprints)];
    const output = new Map<string, ExistingSourceRecord[]>();
    for (const fingerprint of unique) {
      const sources = await this.#database.all<{ id: string; fingerprint: string }>(
        "SELECT id, dedupe_fingerprint AS fingerprint FROM source_records WHERE dedupe_fingerprint = ? AND duplicate_of_source_record_id IS NULL ORDER BY rowid",
        [fingerprint],
      );
      for (const source of sources) {
        const evidence = await this.#database.all<ExistingEvidence>(
          "SELECT te.ledger_entry_id AS ledgerEntryId, le.account_id AS accountId, CAST(te.observed_amount_minor AS TEXT) AS amountMinorText, te.observed_currency AS currency, te.observed_direction AS direction FROM transaction_evidence te JOIN ledger_entries le ON le.id = te.ledger_entry_id WHERE te.source_record_id = ? ORDER BY te.rowid",
          [source.id],
        );
        const list = output.get(source.fingerprint) ?? [];
        list.push({ ...source, evidence });
        output.set(source.fingerprint, list);
      }
    }
    return output;
  }

  async #existingCanonicalObservations(
    observations: readonly NormalizationResult["rows"][number]["observations"][number][],
  ): Promise<Map<string, ExistingCanonicalObservation[]>> {
    const output = new Map<string, ExistingCanonicalObservation[]>();
    const unique = new Map(observations.map((observation) => [observationIdentity(observation), observation]));
    for (const [identity, observation] of unique) {
      const matches = await this.#database.all<{ ledgerEntryId: string }>(
        "SELECT id AS ledgerEntryId FROM ledger_entries WHERE account_id = ? AND amount_minor = CAST(? AS INTEGER) AND currency = ? AND direction = ? AND occurred_at = ? ORDER BY rowid",
        [observation.accountId, observation.amountMinor.toString(), observation.currency, observation.direction, observation.occurredAt],
      );
      output.set(identity, matches);
    }
    return output;
  }

  async #existingProviderReferences(
    observations: readonly NormalizedObservation[],
  ): Promise<Map<string, ExistingReferenceObservation[]>> {
    const output = new Map<string, ExistingReferenceObservation[]>();
    const unique = new Map<string, NormalizedObservation>();
    for (const observation of observations) {
      const identity = providerReferenceIdentity(observation);
      if (identity) unique.set(identity, observation);
    }
    for (const [identity, observation] of unique) {
      const providerReference = observation.providerReference;
      if (!providerReference) continue;
      const matches = await this.#database.all<ExistingReferenceObservation>(
        `SELECT
          le.id AS ledgerEntryId,
          CAST(le.amount_minor AS TEXT) AS amountMinorText,
          le.currency,
          le.direction,
          le.occurred_at AS occurredAt
        FROM transaction_evidence te
        JOIN ledger_entries le ON le.id = te.ledger_entry_id
        JOIN accounts a ON a.id = le.account_id
        JOIN providers p ON p.id = a.provider_id
        WHERE p.code = ? AND le.account_id = ? AND te.provider_reference = ?
        ORDER BY te.rowid`,
        [observation.provider, observation.accountId, providerReference],
      );
      output.set(identity, matches);
    }
    return output;
  }
}

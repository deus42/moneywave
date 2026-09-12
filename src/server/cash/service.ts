import { randomUUID } from "node:crypto";

import { currencyMinorDigits, requireInt64 } from "@/domain/money";
import { hasCashDepositSignal, hasCashWithdrawalSignal } from "@/domain/transaction-signals";
import type { EncryptedDatabase } from "@/server/db/database";

interface CashCandidateRow {
  id: string;
  amountMinorText: string;
  currency: string;
  direction: "debit" | "credit";
  occurredAt: string;
  description: string | null;
  sourceCategory: string | null;
  mcc: string | null;
}

function normalizeDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || Number.isNaN(new Date(`${value}T00:00:00Z`).getTime())) {
    throw new Error("CASH_OPENING_DATE_INVALID");
  }
  return value;
}

function normalizeCurrencies(values: readonly string[]): string[] {
  const currencies = [...new Set(values.map((value) => value.trim().toUpperCase()))].sort();
  if (currencies.length === 0) throw new Error("CASH_CURRENCIES_EMPTY");
  for (const currency of currencies) currencyMinorDigits(currency);
  return currencies;
}

function cashAccountId(currency: string): string {
  return `cash-${currency.toLowerCase()}`;
}

export class CashService {
  readonly #database: EncryptedDatabase;

  constructor(database: EncryptedDatabase) {
    this.#database = database;
  }

  async run(input: {
    openingDate: string;
    currencies: readonly string[];
  }): Promise<{ accountsInitialized: number; movementsCreated: number }> {
    const openingDate = normalizeDate(input.openingDate);
    const currencies = normalizeCurrencies(input.currencies);
    let accountsInitialized = 0;
    let movementsCreated = 0;

    await this.#database.transaction(async () => {
      const candidates = await this.#candidates(openingDate);
      await this.#database.run(
        "INSERT INTO providers (id, code, display_name) VALUES ('provider-cash', 'cash', 'Готівка') ON CONFLICT(code) DO NOTHING",
      );
      const provider = await this.#database.get<{ id: string; displayName: string }>(
        "SELECT id, display_name AS displayName FROM providers WHERE code = 'cash'",
      );
      if (!provider || provider.id !== "provider-cash" || provider.displayName !== "Готівка") throw new Error("CASH_PROVIDER_CONFLICT");

      for (const currency of currencies) {
        const accountId = cashAccountId(currency);
        const existing = await this.#database.get<{
          providerId: string;
          ownerScope: string;
          accountType: string;
          currency: string;
        }>(`
          SELECT provider_id AS providerId, owner_scope AS ownerScope, account_type AS accountType, currency
          FROM accounts WHERE id = ?
        `, [accountId]);
        if (existing && (
          existing.providerId !== "provider-cash"
          || existing.ownerScope !== "PERSONAL"
          || existing.accountType !== "cash"
          || existing.currency !== currency
        )) throw new Error("CASH_ACCOUNT_CONFLICT");
        if (!existing) {
          await this.#database.run(
            "INSERT INTO accounts (id, provider_id, owner_scope, account_type, currency, display_name) VALUES (?, 'provider-cash', 'PERSONAL', 'cash', ?, ?)",
            [accountId, currency, `Готівка ${currency}`],
          );
        }
        const inserted = await this.#database.run(`
          INSERT INTO cash_opening_balances (account_id, opening_date, balance_minor, currency, evidence_kind)
          VALUES (?, ?, 0, ?, 'user_asserted')
          ON CONFLICT(account_id) DO NOTHING
        `, [accountId, openingDate, currency]);
        const opening = await this.#database.get<{ openingDate: string; balance: string; currency: string; evidenceKind: string }>(`
          SELECT opening_date AS openingDate, CAST(balance_minor AS TEXT) AS balance, currency, evidence_kind AS evidenceKind
          FROM cash_opening_balances WHERE account_id = ?
        `, [accountId]);
        if (!opening || opening.openingDate !== openingDate || opening.balance !== "0" || opening.currency !== currency || opening.evidenceKind !== "user_asserted") {
          throw new Error("CASH_OPENING_CONFLICT");
        }
        if (inserted.changes === 1) {
          await this.#database.run(`
            INSERT INTO balance_snapshots (id, account_id, balance_minor, currency, observed_at, evidence_kind)
            VALUES (?, ?, 0, ?, ?, 'manual')
          `, [`cash-opening-snapshot-${currency.toLowerCase()}`, accountId, currency, `${openingDate}T00:00:00Z`]);
          accountsInitialized += 1;
        }
      }

      for (const candidate of candidates) {
        const signalInput = {
          ...candidate,
          description: `${candidate.sourceCategory ?? ""} ${candidate.description ?? ""}`.trim(),
        };
        const withdrawal = hasCashWithdrawalSignal(signalInput);
        const deposit = hasCashDepositSignal(signalInput);
        if (!withdrawal && !deposit) continue;
        const cash = await this.#sourceAmount(candidate);
        if (!currencies.includes(cash.currency)) continue;
        const magnitude = cash.magnitude;
        if (magnitude === 0n) continue;
        const groupId = randomUUID();
        const cashEntryId = randomUUID();
        const cashDirection = withdrawal ? "credit" : "debit";
        const cashAmount = withdrawal ? magnitude : -magnitude;
        const bankLegKind = withdrawal ? "transfer_out" : "transfer_in";
        const cashLegKind = withdrawal ? "transfer_in" : "transfer_out";
        const evidenceKind = candidate.mcc === "6010" || candidate.mcc === "6011"
          ? "cash_mcc"
          : withdrawal ? "cash_withdrawal_description" : "cash_deposit_description";
        await this.#database.run(
          "INSERT INTO ledger_entries (id, account_id, amount_minor, currency, direction, occurred_at, entry_kind, reconciliation_status) VALUES (?, ?, CAST(? AS INTEGER), ?, ?, ?, ?, 'reconciled')",
          [cashEntryId, cashAccountId(cash.currency), cashAmount.toString(), cash.currency, cashDirection, candidate.occurredAt, cashLegKind],
        );
        await this.#database.run(
          "INSERT INTO movement_groups (id, status, evidence_kind, confirmed_at) VALUES (?, 'reconciled', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
          [groupId, evidenceKind],
        );
        await this.#database.run(
          "INSERT INTO movement_legs (id, movement_group_id, ledger_entry_id, leg_kind, position) VALUES (?, ?, ?, ?, 0), (?, ?, ?, ?, 1)",
          [randomUUID(), groupId, candidate.id, bankLegKind, randomUUID(), groupId, cashEntryId, cashLegKind],
        );
        await this.#database.run(
          "UPDATE ledger_entries SET entry_kind = ?, reconciliation_status = 'reconciled' WHERE id = ?",
          [bankLegKind, candidate.id],
        );
        await this.#database.run(
          "DELETE FROM category_assignments WHERE ledger_entry_id = ? AND method NOT IN ('manual', 'user_rule')",
          [candidate.id],
        );
        await this.#database.run(
          "INSERT INTO audit_events (id, event_code, entity_type, entity_id, safe_details_json) VALUES (?, 'CASH_MOVEMENT_DERIVED', 'movement_group', ?, ?)",
          [randomUUID(), groupId, JSON.stringify({ evidenceKind, openingDate })],
        );
        movementsCreated += 1;
      }

      await this.#refreshPositions(currencies);
    });

    return { accountsInitialized, movementsCreated };
  }

  /** Explicit operator repair only; callers must verify a recoverable backup first. */
  async repairDerivedMovements(bankEntryIds: readonly string[]): Promise<{ movementsCorrected: number }> {
    return this.#database.transaction(async () => {
      let movementsCorrected = 0;
      const currencies = new Set<string>();
      for (const id of new Set(bankEntryIds)) {
        const rows = await this.#database.all<Pick<CashCandidateRow, "id" | "amountMinorText" | "currency" | "direction" | "occurredAt"> & {
          groupId: string; cashId: string; cashCurrency: string; cashAmount: string;
        }>(`
          SELECT bank.id, CAST(bank.amount_minor AS TEXT) AS amountMinorText, bank.currency,
            bank.direction, bank.occurred_at AS occurredAt, g.id AS groupId,
            cash.id AS cashId, cash.currency AS cashCurrency, CAST(cash.amount_minor AS TEXT) AS cashAmount
          FROM ledger_entries bank JOIN accounts ba ON ba.id=bank.account_id
          JOIN movement_legs bl ON bl.ledger_entry_id=bank.id
          JOIN movement_groups g ON g.id=bl.movement_group_id
          JOIN movement_legs cl ON cl.movement_group_id=g.id AND cl.ledger_entry_id<>bank.id
          JOIN ledger_entries cash ON cash.id=cl.ledger_entry_id
          JOIN accounts ca ON ca.id=cash.account_id
          WHERE bank.id=? AND ba.account_type<>'cash' AND ca.account_type='cash'
            AND ca.id='cash-' || lower(cash.currency) AND ca.currency=cash.currency
            AND ca.provider_id='provider-cash' AND ca.owner_scope='PERSONAL'
            AND cash.direction<>bank.direction AND cash.occurred_at=bank.occurred_at
            AND g.status='reconciled' AND g.evidence_kind IN ('cash_mcc','cash_withdrawal_description','cash_deposit_description')
            AND (SELECT COUNT(*) FROM movement_legs WHERE movement_group_id=g.id)=2
            AND EXISTS(SELECT 1 FROM audit_events WHERE entity_id=g.id AND event_code='CASH_MOVEMENT_DERIVED')
            AND NOT EXISTS(SELECT 1 FROM transaction_evidence WHERE ledger_entry_id=cash.id)
            AND NOT EXISTS(SELECT 1 FROM category_assignments WHERE ledger_entry_id=cash.id AND method IN ('manual','user_rule'))
            AND NOT EXISTS(SELECT 1 FROM cost_components WHERE movement_group_id=g.id)
            AND NOT EXISTS(SELECT 1 FROM fx_conversions WHERE movement_group_id=g.id)
        `, [id]);
        if (rows.length !== 1) throw new Error("CASH_REPAIR_UNSAFE");
        const row = rows[0];
        const source = await this.#sourceAmount(row);
        if (source.magnitude === 0n) throw new Error("CASH_REPAIR_UNSAFE");
        const amount = (row.direction === "debit" ? source.magnitude : -source.magnitude).toString();
        if (source.currency === row.cashCurrency && amount === row.cashAmount) continue;
        const target = await this.#database.get<{ id: string }>(`
          SELECT a.id FROM accounts a JOIN cash_opening_balances o ON o.account_id=a.id
          WHERE a.id=? AND a.currency=? AND a.account_type='cash' AND a.owner_scope='PERSONAL'
            AND a.provider_id='provider-cash' AND o.currency=a.currency AND o.opening_date<=?
        `, [cashAccountId(source.currency), source.currency, row.occurredAt.slice(0, 10)]);
        if (!target) throw new Error("CASH_REPAIR_TARGET_UNAVAILABLE");
        await this.#database.run("DELETE FROM ledger_entry_valuations WHERE ledger_entry_id=?", [row.cashId]);
        await this.#database.run("UPDATE ledger_entries SET account_id=?, currency=?, amount_minor=CAST(? AS INTEGER) WHERE id=?",
          [target.id, source.currency, amount, row.cashId]);
        await this.#database.run(`INSERT INTO audit_events (id,event_code,entity_type,entity_id,safe_details_json)
          VALUES (?, 'CASH_SOURCE_AMOUNT_CORRECTED','movement_group',?,?)`,
        [randomUUID(), row.groupId, JSON.stringify({ rule: "original-operation-amount-v1" })]);
        currencies.add(row.cashCurrency);
        currencies.add(source.currency);
        movementsCorrected += 1;
      }
      await this.#refreshPositions([...currencies]);
      return { movementsCorrected };
    });
  }

  async #sourceAmount(candidate: Pick<CashCandidateRow, "id" | "amountMinorText" | "currency">): Promise<{ currency: string; magnitude: bigint }> {
    const rows = await this.#database.all<{ amount: string | null; currency: string | null }>(`
      SELECT CAST(source_amount_minor AS TEXT) AS amount, source_currency AS currency
      FROM transaction_evidence WHERE ledger_entry_id=?
        AND (source_amount_minor IS NOT NULL OR source_currency IS NOT NULL)
    `, [candidate.id]);
    let resolved: { currency: string; magnitude: bigint } | undefined;
    for (const row of rows) {
      if (row.amount === null || !row.currency || BigInt(row.amount) === 0n) throw new Error("CASH_SOURCE_EVIDENCE_INVALID");
      currencyMinorDigits(row.currency);
      // Providers may report unsigned operation amounts; direction comes from the bank leg.
      const amount = BigInt(row.amount);
      const magnitude = requireInt64(amount < 0n ? -amount : amount);
      if (resolved && (resolved.currency !== row.currency || resolved.magnitude !== magnitude)) {
        throw new Error("CASH_SOURCE_EVIDENCE_CONFLICT");
      }
      resolved = { currency: row.currency, magnitude };
    }
    if (resolved) return resolved;
    const amount = BigInt(candidate.amountMinorText);
    return { currency: candidate.currency, magnitude: requireInt64(amount < 0n ? -amount : amount) };
  }

  async #refreshPositions(currencies: readonly string[]): Promise<void> {
    for (const currency of currencies) {
      const accountId = cashAccountId(currency);
      const opening = await this.#database.get<{ openingDate: string }>(
        "SELECT opening_date AS openingDate FROM cash_opening_balances WHERE account_id=? AND currency=?", [accountId, currency]);
      if (!opening) throw new Error("CASH_OPENING_CONFLICT");
      const openingDate = opening.openingDate;
      const position = await this.#database.get<{ balance: string; observedAt: string | null }>(`
        SELECT
          CAST(COALESCE((SELECT balance_minor FROM cash_opening_balances WHERE account_id = ?), 0)
            + COALESCE(SUM(amount_minor), 0) AS TEXT) AS balance,
          MAX(occurred_at) AS observedAt
        FROM ledger_entries
        WHERE account_id = ? AND substr(occurred_at, 1, 10) >= ?
      `, [accountId, accountId, openingDate]);
      if (!position) throw new Error("CASH_POSITION_UNAVAILABLE");
      await this.#database.run(`DELETE FROM balance_snapshot_valuations WHERE balance_snapshot_id IN (
        SELECT id FROM balance_snapshots WHERE id=? AND (balance_minor<>CAST(? AS INTEGER) OR observed_at<>?)
      )`, [`cash-derived-snapshot-${currency.toLowerCase()}`, position.balance, position.observedAt ?? `${openingDate}T00:00:00Z`]);
      await this.#database.run(`
        INSERT INTO balance_snapshots (id, account_id, balance_minor, currency, observed_at, evidence_kind)
        VALUES (?, ?, CAST(? AS INTEGER), ?, ?, 'manual')
        ON CONFLICT(id) DO UPDATE SET
          balance_minor = excluded.balance_minor,
          observed_at = excluded.observed_at
      `, [
        `cash-derived-snapshot-${currency.toLowerCase()}`,
        accountId,
        position.balance,
        currency,
        position.observedAt ?? `${openingDate}T00:00:00Z`,
      ]);
      await this.#database.run(
        "UPDATE accounts SET balance_evidence_status = 'derived_from_zero_opening' WHERE id = ?",
        [accountId],
      );
    }
  }

  async #candidates(openingDate: string): Promise<CashCandidateRow[]> {
    return this.#database.all<CashCandidateRow>(`
      SELECT
        le.id,
        CAST(le.amount_minor AS TEXT) AS amountMinorText,
        le.currency,
        le.direction,
        le.occurred_at AS occurredAt,
        le.private_description AS description,
        (
          SELECT COALESCE(json_extract(sr.source_metadata_json, '$.sourceCategory'), json_extract(sr.source_metadata_json, '$.statementCategory'))
          FROM transaction_evidence te
          JOIN source_records sr ON sr.id = te.source_record_id
          WHERE te.ledger_entry_id = le.id
          ORDER BY te.rowid
          LIMIT 1
        ) AS sourceCategory,
        (
          SELECT json_extract(sr.source_metadata_json, '$.mcc')
          FROM transaction_evidence te
          JOIN source_records sr ON sr.id = te.source_record_id
          WHERE te.ledger_entry_id = le.id
          ORDER BY te.rowid
          LIMIT 1
        ) AS mcc
      FROM ledger_entries le
      JOIN accounts account ON account.id = le.account_id
      JOIN providers provider ON provider.id = account.provider_id
      WHERE provider.code <> 'cash'
        AND substr(le.occurred_at, 1, 10) >= ?
        AND NOT EXISTS (SELECT 1 FROM movement_legs leg WHERE leg.ledger_entry_id = le.id)
      ORDER BY le.occurred_at, le.id
    `, [openingDate]);
  }
}

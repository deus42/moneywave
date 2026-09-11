import { randomUUID } from "node:crypto";

import { currencyMinorDigits } from "@/domain/money";
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
    const candidates = await this.#candidates(openingDate);
    let accountsInitialized = 0;
    let movementsCreated = 0;

    await this.#database.transaction(async () => {
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
        if (!currencies.includes(candidate.currency)) continue;
        const signalInput = {
          ...candidate,
          description: `${candidate.sourceCategory ?? ""} ${candidate.description ?? ""}`.trim(),
        };
        const withdrawal = hasCashWithdrawalSignal(signalInput);
        const deposit = hasCashDepositSignal(signalInput);
        if (!withdrawal && !deposit) continue;
        const magnitude = BigInt(candidate.amountMinorText) < 0n
          ? -BigInt(candidate.amountMinorText)
          : BigInt(candidate.amountMinorText);
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
          [cashEntryId, cashAccountId(candidate.currency), cashAmount.toString(), candidate.currency, cashDirection, candidate.occurredAt, cashLegKind],
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

      for (const currency of currencies) {
        const accountId = cashAccountId(currency);
        const position = await this.#database.get<{ balance: string; observedAt: string | null }>(`
          SELECT
            CAST(COALESCE((SELECT balance_minor FROM cash_opening_balances WHERE account_id = ?), 0)
              + COALESCE(SUM(amount_minor), 0) AS TEXT) AS balance,
            MAX(occurred_at) AS observedAt
          FROM ledger_entries
          WHERE account_id = ? AND substr(occurred_at, 1, 10) >= ?
        `, [accountId, accountId, openingDate]);
        if (!position) throw new Error("CASH_POSITION_UNAVAILABLE");
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
    });

    return { accountsInitialized, movementsCreated };
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

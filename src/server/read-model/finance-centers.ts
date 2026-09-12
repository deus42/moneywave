import Decimal from "decimal.js";
import { currencyMinorDigits } from "@/domain/money";
import { parseReportMonth, type ReportCurrency } from "@/domain/reporting";
import type { EncryptedDatabase } from "@/server/db/database";
import { latestManualPositions, type ManualPositionEvidence } from "@/server/manual/position-reader";
import { monthEnd } from "@/server/manual/position-workbook";

const ExactDecimal = Decimal.clone({ precision: 50, rounding: Decimal.ROUND_HALF_UP });

export interface CapitalPosition {
  id: string;
  name: string;
  provider: string;
  providerCode: string;
  scope: "PERSONAL" | "SOLE_PROPRIETOR";
  type: string;
  currency: string;
  nativeMinor: string | null;
  reportMinor: string | null;
  observedAt: string | null;
  source: string | null;
  status: "known" | "missing_balance" | "missing_rate" | "conflict";
  carriedForward: boolean;
  rate: string | null;
  rateSource: string | null;
  publicationDate: string | null;
  rateStale: boolean;
  accountId: string | null;
  precision: "day" | "month";
  manualEvidence: ManualPositionEvidence | null;
}

export interface CapitalView {
  asOf: string;
  currency: ReportCurrency;
  positions: CapitalPosition[];
  knownAssetsMinor: string;
  knownLiabilitiesMinor: string;
  knownNetMinor: string;
  // Imported account coverage is not evidence that the entire estate is known.
  completeNetWorthMinor: null;
  unvaluedCount: number;
  carriedForwardCount: number;
}

export interface SpendingCategory {
  code: string;
  name: string;
  currentMinor: string;
  previousMinor: string | null;
  count: number;
  missingValuations: number;
  currentMissingValuations: number;
}

export interface SpendingView {
  month: string;
  previousMonth: string;
  currency: ReportCurrency;
  currentMinor: string;
  previousMinor: string | null;
  deltaMinor: string | null;
  count: number;
  missingValuations: number;
  currentMissingValuations: number;
  previousMissingValuations: number;
  previousCount: number;
  uncategorizedCount: number;
  categories: SpendingCategory[];
}

function isoDay(value: string | undefined, today: string): string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/u.test(value) || value > today) return today;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : today;
}

function shiftMonth(month: string, offset: number): string {
  const date = new Date(`${month}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + offset);
  return date.toISOString().slice(0, 7);
}

interface CachedRate { base: string; rate: string; source: string; publicationDate: string }

export interface CapitalHistoryPoint {
  asOf: string;
  knownMinor: string;
  valuedCount: number;
  missingCount: number;
  manualCount: number;
}

/** Explicit cash facts supplied by a caller, independent of website storage. */
export interface CashOutflow {accountId:string;currency:string;date:string;amountMinor:number}

/** Read-only projections. No import, categorization, FX request or correction on a page read. */
export class FinanceCenters {
  constructor(private readonly database: EncryptedDatabase, private readonly now = () => new Date()) {}

  async capital(requestedDate: string | undefined, currency: ReportCurrency, includePosition?: (position: CapitalPosition) => boolean, cashOutflows:readonly CashOutflow[]=[]): Promise<CapitalView> {
    const asOf = isoDay(requestedDate, this.now().toISOString().slice(0, 10));
    const accounts = await this.database.all<Pick<CapitalPosition, "id" | "name" | "provider" | "providerCode" | "scope" | "type" | "currency">>(`
      SELECT account.id, account.display_name AS name, provider.display_name AS provider,
        provider.code AS providerCode,
        account.owner_scope AS scope, account.account_type AS type, account.currency
      FROM accounts account JOIN providers provider ON provider.id = account.provider_id
      ORDER BY account.owner_scope, provider.display_name, account.currency, account.display_name, account.id
    `);
    const manual = await latestManualPositions(this.database, asOf);
    for (const position of manual.filter((p) => !p.accountId)) accounts.push({ id: `manual:${position.seriesId}`,
      name: position.name, provider: position.provider, providerCode: position.provider, scope: "PERSONAL", type: "manual", currency: position.currency });
    // Reuse official rate evidence already stored by the existing valuation engine.
    // Publication and requested dates must both be on/before the chosen stock date.
    const rates = await this.database.all<CachedRate>(`
      SELECT base, rate, source, publicationDate FROM (
        SELECT base_currency AS base, quote_currency AS target, rate_text AS rate, source,
          publication_date AS publicationDate, requested_date AS requestedDate FROM fx_rate_cache
        UNION
        SELECT source_currency, target_currency, rate_text, source, publication_date, requested_date
          FROM ledger_entry_valuations WHERE source != 'identity'
        UNION
        SELECT source_currency, target_currency, rate_text, source, publication_date, requested_date
          FROM balance_snapshot_valuations WHERE source != 'identity'
      ) WHERE target = ? AND publicationDate <= ? AND requestedDate <= ?
      ORDER BY publicationDate DESC, CASE source WHEN 'ECB' THEN 0 ELSE 1 END, requestedDate DESC
    `, [currency, asOf, asOf]);
    const positions: CapitalPosition[] = [];
    for (const account of accounts) {
      const expenses=cashOutflows.filter(e=>e.accountId===account.id&&e.currency===account.currency&&e.date<=asOf);
      const spent=(from:string,to:string,inclusive=true)=>expenses.filter(e=>(inclusive?e.date>=from:e.date>from)&&e.date<=to).reduce((sum,e)=>sum+BigInt(e.amountMinor),0n);
      const position: CapitalPosition = { ...account, nativeMinor: null, reportMinor: null, observedAt: null,
        source: null, status: "missing_balance", carriedForward: false, rate: null, rateSource: null,
        publicationDate: null, rateStale: false, accountId: account.type === "manual" ? null : account.id,
        precision: "day", manualEvidence: null };
      if (account.type === "cash") {
        const opening = await this.database.get<{ amount: string; date: string }>(`
          SELECT CAST(balance_minor AS TEXT) AS amount, opening_date AS date FROM cash_opening_balances
          WHERE account_id = ? AND currency = ? AND opening_date <= ?
        `, [account.id, account.currency, asOf]);
        if (opening) {
          const movements = await this.database.all<{ amount: string; occurredAt: string }>(`
            SELECT CAST(amount_minor AS TEXT) AS amount, occurred_at AS occurredAt FROM ledger_entries
            WHERE account_id = ? AND currency = ? AND substr(occurred_at, 1, 10) BETWEEN ? AND ?
            ORDER BY occurred_at, id
          `, [account.id, account.currency, opening.date, asOf]);
          position.nativeMinor = (movements.reduce((sum, row) => sum + BigInt(row.amount), BigInt(opening.amount))-spent(opening.date,asOf)).toString();
          position.observedAt = movements.at(-1)?.occurredAt ?? opening.date;
          position.source = "calculated_cash";
          position.status = BigInt(position.nativeMinor) < 0n ? "conflict" : "known";
        }
      } else {
        const snapshots = await this.database.all<{ amount: string; observedAt: string; source: string; currency: string }>(`
          SELECT CAST(balance_minor AS TEXT) AS amount, observed_at AS observedAt, evidence_kind AS source, currency
          FROM balance_snapshots WHERE account_id = ? AND substr(observed_at, 1, 10) <= ?
          ORDER BY substr(observed_at, 1, 19) DESC, rowid DESC
        `, [account.id, asOf]);
        const latest = snapshots[0];
        if (latest) {
          position.observedAt = latest.observedAt;
          position.source = latest.source;
          const conflicting = snapshots.some((row) => row.observedAt.slice(0, 19) === latest.observedAt.slice(0, 19)
            && (row.amount !== latest.amount || row.currency !== latest.currency));
          position.status = conflicting || latest.currency !== account.currency ? "conflict" : "known";
          if (position.status === "known") position.nativeMinor = latest.amount;
        }
      }
      const manualEvidence = manual.find((m) => m.accountId === account.id || `manual:${m.seriesId}` === account.id);
      if (manualEvidence) {
        position.manualEvidence = manualEvidence;
        const boundary = monthEnd(manualEvidence.period);
        const bankHasAuthority = account.type !== "cash" && position.observedAt && position.observedAt.slice(0, 7) >= manualEvidence.period;
        if (bankHasAuthority) {
          manualEvidence.comparison = position.observedAt!.slice(0, 7) === manualEvidence.period ? "month_precision" : "older_evidence";
          if (manualEvidence.comparison === "month_precision" && position.nativeMinor !== null && manualEvidence.amountMinor !== null) {
            manualEvidence.differenceMinor = (BigInt(manualEvidence.amountMinor) - BigInt(position.nativeMinor)).toString();
          }
        } else {
          if (account.type === "cash" && manualEvidence.amountMinor !== null) {
            const opening = await this.database.get<{ amount: string; date: string }>(`
              SELECT CAST(balance_minor AS TEXT) AS amount, opening_date AS date FROM cash_opening_balances
              WHERE account_id = ? AND currency = ? AND opening_date <= ?`, [account.id, account.currency, boundary]);
            if (opening) {
              const recorded = await this.database.all<{ amount: string }>(`
                SELECT CAST(amount_minor AS TEXT) AS amount FROM ledger_entries WHERE account_id = ? AND currency = ?
                AND substr(occurred_at,1,10) BETWEEN ? AND ?`, [account.id, account.currency, opening.date, boundary]);
              const calculated = recorded.reduce((sum, row) => sum + BigInt(row.amount), BigInt(opening.amount))-spent(opening.date,boundary);
              manualEvidence.differenceMinor = (BigInt(manualEvidence.amountMinor) - calculated).toString();
              manualEvidence.comparison = "cash_record_gap";
            }
          }
          position.source = account.type === "cash" ? "manual_cash" : "manual_document";
          position.observedAt = manualEvidence.period;
          position.precision = "month";
          position.nativeMinor = manualEvidence.amountMinor;
          position.status = manualEvidence.conflicting ? "conflict" : "known";
          if (account.type === "cash" && position.nativeMinor !== null) {
            const later = await this.database.all<{ amount: string }>(`
              SELECT CAST(amount_minor AS TEXT) AS amount FROM ledger_entries WHERE account_id = ? AND currency = ?
              AND substr(occurred_at,1,10) > ? AND substr(occurred_at,1,10) <= ?`, [account.id, account.currency, boundary, asOf]);
            position.nativeMinor = (later.reduce((sum, row) => sum + BigInt(row.amount), BigInt(position.nativeMinor))-spent(boundary,asOf,false)).toString();
            if (BigInt(position.nativeMinor) < 0n) position.status = "conflict";
          }
        }
      }
      position.carriedForward = !!position.observedAt && (position.precision === "month" ? monthEnd(position.observedAt) : position.observedAt.slice(0, 10)) < asOf;
      if (position.status === "known" && position.nativeMinor !== null) {
        const rate = account.currency === currency
          ? { rate: "1", source: "identity", publicationDate: asOf }
          : rates.find((row) => row.base === account.currency);
        if (!rate || !new ExactDecimal(rate.rate).isFinite() || !new ExactDecimal(rate.rate).gt(0)) {
          position.status = "missing_rate";
        } else {
          position.rate = rate.rate;
          position.rateSource = rate.source;
          position.publicationDate = rate.publicationDate;
          position.rateStale = (Date.parse(asOf) - Date.parse(rate.publicationDate)) > 7 * 86_400_000;
          position.reportMinor = new ExactDecimal(position.nativeMinor)
            .mul(rate.rate).mul(new ExactDecimal(10).pow(currencyMinorDigits(currency) - currencyMinorDigits(account.currency)))
            .toFixed(0);
        }
      }
      if (!includePosition || includePosition(position)) positions.push(position);
    }
    const known = positions.filter((position) => position.reportMinor !== null).map((position) => BigInt(position.reportMinor!));
    return { asOf, currency, positions, knownAssetsMinor: known.filter((v) => v > 0n).reduce((a, b) => a + b, 0n).toString(),
      knownLiabilitiesMinor: known.filter((v) => v < 0n).reduce((a, b) => a - b, 0n).toString(),
      knownNetMinor: known.reduce((a, b) => a + b, 0n).toString(), completeNetWorthMinor: null,
      unvaluedCount: positions.length - known.length, carriedForwardCount: positions.filter((p) => p.carriedForward).length };
  }

  async capitalHistory(requestedDate: string | undefined, currency: ReportCurrency, includePosition?: (position: CapitalPosition) => boolean, cashOutflows:readonly CashOutflow[]=[]): Promise<CapitalHistoryPoint[]> {
    const asOf = isoDay(requestedDate, this.now().toISOString().slice(0, 10));
    const rows = await this.database.all<{ period: string }>(`
      SELECT period FROM manual_position_facts
      UNION SELECT substr(observed_at,1,7) FROM balance_snapshots
      UNION SELECT substr(opening_date,1,7) FROM cash_opening_balances ORDER BY period`);
    const start = shiftMonth(asOf.slice(0, 7), -23);
    const periods = [...new Set([...rows.map(r=>r.period),...cashOutflows.map(e=>e.date.slice(0,7))])].sort().map(period=>({period})).filter(({ period }) => /^\d{4}-(0[1-9]|1[0-2])$/u.test(period) && period >= start && period <= asOf.slice(0, 7) && monthEnd(period) <= asOf);
    const history: CapitalHistoryPoint[] = [];
    for (const { period } of periods) {
      const view = await this.capital(monthEnd(period), currency, includePosition,cashOutflows);
      history.push({ asOf: view.asOf, knownMinor: view.knownNetMinor, valuedCount: view.positions.length - view.unvaluedCount,
        missingCount: view.unvaluedCount, manualCount: view.positions.filter((p) => p.source === "manual_document" || p.source === "manual_cash").length });
    }
    return history;
  }

  async spending(requestedMonth: string | undefined, currency: ReportCurrency): Promise<SpendingView> {
    const thisMonth = this.now().toISOString().slice(0, 7);
    const parsed = parseReportMonth(requestedMonth);
    const month = parsed && parsed < thisMonth ? parsed : shiftMonth(thisMonth, -1);
    const previousMonth = shiftMonth(month, -1);
    const rows = await this.database.all<{ month: string; code: string; name: string; amount: string | null }>(`
      SELECT substr(entry.occurred_at, 1, 7) AS month,
        COALESCE(parent.code, category.code, 'uncategorized') AS code,
        COALESCE(parent.display_name, category.display_name, 'Без категорії') AS name,
        CASE WHEN entry.currency = ? THEN CAST(entry.amount_minor AS TEXT)
          ELSE CAST(valuation.converted_amount_minor AS TEXT) END AS amount
      FROM ledger_entries entry JOIN accounts account ON account.id = entry.account_id
      LEFT JOIN category_assignments assignment ON assignment.rowid = (
        SELECT inner_assignment.rowid FROM category_assignments inner_assignment
        WHERE inner_assignment.ledger_entry_id = entry.id ORDER BY assigned_at DESC, rowid DESC LIMIT 1)
      LEFT JOIN categories category ON category.id = assignment.category_id
      LEFT JOIN categories parent ON parent.id = category.parent_id
      LEFT JOIN ledger_entry_valuations valuation ON valuation.ledger_entry_id = entry.id AND valuation.target_currency = ?
      WHERE account.owner_scope = 'PERSONAL' AND entry.entry_kind = 'terminal_personal_expense' AND entry.direction = 'debit'
        AND substr(entry.occurred_at, 1, 7) BETWEEN ? AND ? ORDER BY entry.occurred_at, entry.id
    `, [currency, currency, previousMonth, month]);
    const current = rows.filter((r) => r.month === month);
    const previous = rows.filter((r) => r.month === previousMonth);
    const sum = (items: typeof rows) => items.reduce((total, row) => total - BigInt(row.amount ?? "0"), 0n);
    const missingValuations = rows.filter((r) => r.amount === null).length;
    const currentMinor = sum(current);
    const previousMinor = previous.length ? sum(previous) : null;
    const categories = [...new Set(rows.map((r) => r.code))].map((code) => {
      const selected = current.filter((r) => r.code === code);
      const preceding = previous.filter((r) => r.code === code);
      return { code, name: rows.find((r) => r.code === code)!.name, currentMinor: sum(selected).toString(),
        previousMinor: previousMinor === null ? null : sum(preceding).toString(), count: selected.length,
        currentMissingValuations: selected.filter((r) => r.amount === null).length,
        missingValuations: [...selected, ...preceding].filter((r) => r.amount === null).length };
    }).sort((a, b) => BigInt(a.currentMinor) > BigInt(b.currentMinor) ? -1 : BigInt(a.currentMinor) < BigInt(b.currentMinor) ? 1 : a.name.localeCompare(b.name));
    return { month, previousMonth, currency, currentMinor: currentMinor.toString(), previousMinor: previousMinor?.toString() ?? null,
      deltaMinor: previousMinor === null || missingValuations || !current.length ? null : (currentMinor - previousMinor).toString(),
      currentMissingValuations: current.filter((r) => r.amount === null).length,
      previousMissingValuations: previous.filter((r) => r.amount === null).length, previousCount: previous.length,
      count: current.length, missingValuations, uncategorizedCount: current.filter((r) => r.code === "uncategorized").length, categories };
  }
}

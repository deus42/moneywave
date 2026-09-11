import { calculateConsolidatedFlow, type ConsolidatedEntryKind } from "@/domain/consolidated-flow";
import type { MovementRoute, TransactionMode, TransactionSort } from "@/domain/explorer";
import {
  parseReportPeriod,
  parseReportMonth,
  reportMonthRange,
  previousReportPeriodRange,
  reportPeriodStart,
  type ReportPeriod,
} from "@/domain/reporting";
import type { EncryptedDatabase, SqlParameter } from "@/server/db/database";
import type { OwnerScope } from "@/server/import/types";

export interface AccountView {
  id: string;
  displayName: string;
  ownerScope: OwnerScope;
  accountType: string;
  currency: string;
  balanceMinor: string | null;
  balanceObservedAt: string | null;
  balanceEvidenceStatus: string;
  reportBalanceMinor: string | null;
  reportCurrency: string | null;
  valuationMissing: boolean;
}

export interface FlowView {
  currency: string;
  grossIncomeMinor: string;
  spendingMinor: string;
  internalMovementMinor: string;
}

export interface ReviewCounts {
  pendingMovements: number;
  unresolvedRows: number;
  rejectedRows: number;
  openConflicts: number;
  lowConfidenceCategories: number;
  importIssues: number;
}

export interface OverviewView {
  accounts: AccountView[];
  flows: FlowView[];
  previousFlows: FlowView[];
  transactionCount: number;
  reviewCount: number;
  period: ReportPeriod;
  anchorAt: string | null;
  timeline: TimelinePointView[];
  recentTransactions: TransactionView[];
  missingValuationCount: number;
}

export interface TimelinePointView {
  month: string;
  currency: string;
  incomeMinor: string;
  spendingMinor: string;
}

export interface TransactionView {
  id: string;
  accountId: string;
  accountName: string;
  ownerScope: OwnerScope;
  amountMinor: string;
  currency: string;
  direction: "debit" | "credit";
  occurredAt: string;
  entryKind: string;
  description: string | null;
  evidenceCount: number;
  categoryCode: string | null;
  categoryName: string | null;
  categoryMethod: string | null;
  needsReview: boolean;
  movementGroupId: string | null;
  movementStatus: string | null;
  movementEvidenceKind: string | null;
  movementCostCount: number;
  reportAmountMinor: string | null;
  reportCurrency: string | null;
  valuationMissing: boolean;
  valuations: TransactionValuationView[];
}

export interface TransactionValuationView {
  currency: string;
  amountMinor: string;
  rate: string;
  source: "identity" | "ECB" | "NBU";
  publicationDate: string;
}

export interface TransactionPageView {
  items: TransactionView[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

export interface CategoryTotalView {
  categoryCode: string;
  categoryName: string;
  currency: string;
  amountMinor: string;
  transactionCount: number;
  missingValuationCount?: number;
}

export interface CategoryTrendView extends CategoryTotalView {
  month: string;
}

export interface CategoryAnalyticsView {
  period: ReportPeriod;
  anchorAt: string | null;
  totals: CategoryTotalView[];
  previousTotals: CategoryTotalView[];
  trends: CategoryTrendView[];
  terminalPersonalEntries: number;
  categorizedTerminalEntries: number;
  missingValuationCount?: number;
}

export interface MovementTransferAggregateView {
  sourceAccountId: string | null;
  destinationAccountId: string | null;
  fromAccountName: string;
  fromOwnerScope: OwnerScope;
  toAccountName: string;
  toOwnerScope: OwnerScope;
  sourceCurrency: string;
  destinationCurrency: string;
  sourceAmountMinor: string;
  destinationAmountMinor: string;
  groupCount: number;
  automaticGroupCount: number;
  reportCurrency?: string | null;
  sourceReportAmountMinor?: string | null;
  destinationReportAmountMinor?: string | null;
  sourceValuationMissingCount?: number;
  destinationValuationMissingCount?: number;
}

export interface TerminalSpendingAggregateView {
  accountName: string;
  categoryCode: string;
  categoryName: string;
  currency: string;
  amountMinor: string;
  transactionCount: number;
  reportAmountMinor?: string | null;
  reportCurrency?: string | null;
  valuationMissingCount?: number;
}

export interface BusinessUseAggregateView {
  entryKind: string;
  currency: string;
  amountMinor: string;
  transactionCount: number;
  reportAmountMinor?: string | null;
  reportCurrency?: string | null;
  valuationMissingCount?: number;
}

export interface UnlinkedTransferAggregateView {
  direction: "debit" | "credit";
  accountName: string;
  ownerScope: OwnerScope;
  currency: string;
  amountMinor: string;
  transactionCount: number;
  reportAmountMinor?: string | null;
  reportCurrency?: string | null;
  valuationMissingCount?: number;
}

export interface CostAggregateView {
  method: string;
  currency: string;
  amountMinor: string;
  estimated: boolean;
  componentCount: number;
  reportAmountMinor?: string | null;
  reportCurrency?: string | null;
  valuationMissingCount?: number;
}

export interface MoneyFlowOverviewView {
  period: ReportPeriod;
  anchorAt: string | null;
  transfers: MovementTransferAggregateView[];
  terminalSpending: TerminalSpendingAggregateView[];
  businessUses: BusinessUseAggregateView[];
  unlinkedRoutes: UnlinkedTransferAggregateView[];
  costs: CostAggregateView[];
  confirmedGroups: number;
  automaticGroups: number;
  rejectedCandidates: number;
  unlinkedTransfers: number;
  linkedLegs: number;
  missingValuationCount?: number;
}

export interface DataHealthView {
  pendingCandidates: number;
  rejectedCandidates: number;
  confirmedGroups: number;
  automaticGroups: number;
  unresolvedRows: number;
  rejectedRows: number;
  openConflicts: number;
  importIssues: number;
  personalEntries: number;
  categorizedPersonalEntries: number;
}

export interface MovementCandidateView {
  id: string;
  matchKind: "exact" | "near_amount" | "cross_currency";
  debitEntryId: string;
  debitAccountName: string;
  debitAmountMinor: string;
  debitCurrency: string;
  debitOccurredAt: string;
  creditEntryId: string;
  creditAccountName: string;
  creditAmountMinor: string;
  creditCurrency: string;
  creditOccurredAt: string;
}

export interface ReviewView {
  counts: ReviewCounts;
  candidates: MovementCandidateView[];
  unresolvedReasons: Array<{ reasonCode: string; count: number }>;
  conflictReasons: Array<{ reasonCode: string; count: number }>;
  importIssueReasons: Array<{ reasonCode: string; count: number }>;
  undatedRows: Array<{
    sourceRecordId: string;
    reasonCode: string;
    legs: Array<{
      accountName: string;
      amountMinor: string;
      currency: string;
      direction: "debit" | "credit";
      description: string | null;
    }>;
  }>;
  lowConfidence: Array<{
    entryId: string;
    categoryName: string;
    confidence: string | null;
    accountName: string;
    occurredAt: string;
  }>;
}

export interface MovementLegView {
  id: string;
  entryId: string;
  accountId: string;
  accountName: string;
  ownerScope: OwnerScope;
  amountMinor: string;
  currency: string;
  direction: "debit" | "credit";
  occurredAt: string;
  legKind: string;
  position: number;
  reportAmountMinor: string | null;
  reportCurrency: string | null;
  valuationMissing: boolean;
}

export interface MovementGroupView {
  id: string;
  status: "candidate" | "confirmed" | "reconciled" | "unlinked";
  evidenceKind: string;
  confirmedAt: string | null;
  legs: MovementLegView[];
  costCount: number;
}

export interface MovementChainEndpointView {
  accountName: string;
  ownerScope: OwnerScope;
  amountMinor: string;
  currency: string;
  reportAmountMinor: string | null;
  reportCurrency: string | null;
}

export interface MovementChainView {
  id: string;
  status: "confirmed" | "reconciled";
  evidenceKind: string;
  occurredAt: string;
  source: MovementChainEndpointView | null;
  destination: MovementChainEndpointView | null;
  legs: MovementLegView[];
  costs: CostView[];
}

export interface MovementPageView {
  items: MovementChainView[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

interface MovementSearch {
  period?: ReportPeriod;
  reportCurrency?: string;
  costMethod?: string;
  route?: MovementRoute;
  page?: number;
  pageSize?: number;
  id?: string;
}

// Mirrors the existing consolidated ledger classification; no inference on reads.
function transactionModeWhere(mode?: TransactionMode): string | null {
  switch (mode) {
    case "expenses": return "le.direction = 'debit' AND le.entry_kind IN ('tax','mandatory_payment','business_expense','terminal_personal_expense','explicit_fee')";
    case "income": return "le.direction = 'credit' AND le.entry_kind = 'business_income'";
    case "transfers": return "le.entry_kind IN ('owner_draw','transfer_in','transfer_out')";
    case "fx": return "le.entry_kind IN ('fx_sell','fx_buy')";
    default: return null;
  }
}

export interface CostView {
  id: string;
  movementGroupId: string;
  groupStatus: string;
  method: string;
  amountMinor: string;
  currency: string;
  estimated: boolean;
  benchmarkSource: string | null;
  publicationDate: string | null;
  reportAmountMinor: string | null;
  reportCurrency: string | null;
  valuationMissing: boolean;
}

export interface FeeAttachmentCandidateView {
  id: string;
  accountName: string;
  amountMinor: string;
  currency: string;
  occurredAt: string;
}

export interface ImportBatchView {
  id: string;
  status: string;
  parserKind: string;
  parserVersion: string;
  importedAt: string;
  committedAt: string | null;
  rowCount: number;
  postedCount: number;
  nonPostedCount: number;
  unresolvedCount: number;
  rejectedCount: number;
  issueCodes: string[];
}

const ENTRY_KINDS = new Set<ConsolidatedEntryKind>([
  "business_income",
  "tax",
  "mandatory_payment",
  "business_expense",
  "owner_draw",
  "transfer_in",
  "transfer_out",
  "fx_sell",
  "fx_buy",
  "terminal_personal_expense",
  "explicit_fee",
  "unclassified",
]);

function consolidatedFlowView(entries: Array<{ amountMinor: string; currency: string; entryKind: string }>): FlowView[] {
  return calculateConsolidatedFlow(entries.map((entry) => ({
    amountMinor: BigInt(entry.amountMinor),
    currency: entry.currency,
    entryKind: ENTRY_KINDS.has(entry.entryKind as ConsolidatedEntryKind)
      ? entry.entryKind as ConsolidatedEntryKind
      : "unclassified",
  }))).map((flow) => ({
    currency: flow.currency,
    grossIncomeMinor: flow.grossIncomeMinor.toString(),
    spendingMinor: flow.spendingMinor.toString(),
    internalMovementMinor: flow.internalMovementMinor.toString(),
  }));
}

function literalSearch(value: string): string {
  // SQLite lower()/NOCASE only fold ASCII. Expand single-codepoint letter pairs
  // in a bound GLOB pattern; user punctuation never becomes a wildcard.
  const pattern = [...value].map(character => {
    if (character === "*") return "[*]";
    if (character === "?") return "[?]";
    if (character === "[") return "[[]";
    const lower = character.toLocaleLowerCase("uk"), upper = character.toLocaleUpperCase("uk");
    return lower !== upper && [...lower].length === 1 && [...upper].length === 1 ? `[${lower}${upper}]` : character;
  }).join("");
  return `*${pattern}*`;
}

interface CategoryLedgerRow {
  categoryCode: string;
  categoryName: string;
  month: string;
  amountMinor: string | null;
}

function aggregateCategoryRows(rows: readonly CategoryLedgerRow[], currency: string): CategoryTotalView[] {
  const totals = new Map<string, CategoryTotalView>();
  for (const row of rows) {
    const key = row.categoryCode;
    const existing = totals.get(key) ?? {
      categoryCode: row.categoryCode,
      categoryName: row.categoryName,
      currency,
      amountMinor: "0",
      transactionCount: 0,
    };
    if (row.amountMinor !== null) existing.amountMinor = (BigInt(existing.amountMinor) - BigInt(row.amountMinor)).toString();
    else existing.missingValuationCount = (existing.missingValuationCount ?? 0) + 1;
    existing.transactionCount += 1;
    totals.set(key, existing);
  }
  return [...totals.values()].sort((left, right) => {
    const amountOrder = BigInt(right.amountMinor) > BigInt(left.amountMinor)
      ? 1
      : BigInt(right.amountMinor) < BigInt(left.amountMinor) ? -1 : 0;
    return amountOrder || left.categoryName.localeCompare(right.categoryName);
  });
}

function aggregateCategoryTrends(rows: readonly CategoryLedgerRow[], currency: string): CategoryTrendView[] {
  const totals = new Map<string, CategoryTrendView>();
  for (const row of rows) {
    const key = `${row.month}:${row.categoryCode}`;
    const existing = totals.get(key) ?? {
      month: row.month,
      categoryCode: row.categoryCode,
      categoryName: row.categoryName,
      currency,
      amountMinor: "0",
      transactionCount: 0,
    };
    if (row.amountMinor !== null) existing.amountMinor = (BigInt(existing.amountMinor) - BigInt(row.amountMinor)).toString();
    else existing.missingValuationCount = (existing.missingValuationCount ?? 0) + 1;
    existing.transactionCount += 1;
    totals.set(key, existing);
  }
  return [...totals.values()].sort((left, right) => {
    const monthOrder = left.month.localeCompare(right.month);
    if (monthOrder !== 0) return monthOrder;
    if (BigInt(right.amountMinor) > BigInt(left.amountMinor)) return 1;
    if (BigInt(right.amountMinor) < BigInt(left.amountMinor)) return -1;
    return left.categoryName.localeCompare(right.categoryName);
  });
}

function normalizeReportCurrency(value: string | undefined): "UAH" | "EUR" | "USD" | undefined {
  if (value === undefined) return undefined;
  const currency = value.trim().toUpperCase();
  if (!(["UAH", "EUR", "USD"] as const).includes(currency as "UAH" | "EUR" | "USD")) {
    throw new Error("REPORT_CURRENCY_INVALID");
  }
  return currency as "UAH" | "EUR" | "USD";
}

export class MoneyWaveReadRepository {
  readonly #database: EncryptedDatabase;
  readonly #now: () => Date;

  constructor(database: EncryptedDatabase, now: () => Date = () => new Date()) {
    this.#database = database;
    this.#now = now;
  }

  async accounts(reportCurrencyInput?: string): Promise<AccountView[]> {
    const reportCurrency = normalizeReportCurrency(reportCurrencyInput);
    const rows = await this.#database.all<Omit<AccountView, "valuationMissing"> & { valuationMissing: number }>(`
      SELECT
        a.id,
        a.display_name AS displayName,
        a.owner_scope AS ownerScope,
        a.account_type AS accountType,
        a.currency,
        CAST(bs.balance_minor AS TEXT) AS balanceMinor,
        bs.observed_at AS balanceObservedAt,
        a.balance_evidence_status AS balanceEvidenceStatus,
        ${reportCurrency ? "CAST(valuation.converted_amount_minor AS TEXT)" : "CAST(bs.balance_minor AS TEXT)"} AS reportBalanceMinor,
        ${reportCurrency ? "?" : "a.currency"} AS reportCurrency,
        CASE WHEN bs.id IS NOT NULL AND ${reportCurrency ? "valuation.balance_snapshot_id" : "bs.id"} IS NULL THEN 1 ELSE 0 END AS valuationMissing
      FROM accounts a
      LEFT JOIN balance_snapshots bs ON bs.rowid = (
        SELECT inner_bs.rowid
        FROM balance_snapshots inner_bs
        WHERE inner_bs.account_id = a.id
        ORDER BY inner_bs.observed_at DESC, inner_bs.rowid DESC
        LIMIT 1
      )
      ${reportCurrency ? "LEFT JOIN balance_snapshot_valuations valuation ON valuation.balance_snapshot_id = bs.id AND valuation.target_currency = ?" : ""}
      ORDER BY CASE a.owner_scope WHEN 'SOLE_PROPRIETOR' THEN 0 ELSE 1 END, a.display_name, a.currency
    `, reportCurrency ? [reportCurrency, reportCurrency] : []);
    return rows.map((row) => ({ ...row, valuationMissing: row.valuationMissing === 1 }));
  }

  async overview(periodInput: string | undefined = "all", reportCurrencyInput?: string): Promise<OverviewView> {
    const period = parseReportPeriod(periodInput);
    const reportCurrency = normalizeReportCurrency(reportCurrencyInput);
    const context = await this.#periodContext(period);
    const filter = context.startAt ? `WHERE occurred_at >= substr(?, 1, 19)${context.endAt ? " AND occurred_at < substr(?, 1, 19)" : ""}` : "";
    const parameters = context.startAt ? [context.startAt, ...(context.endAt ? [context.endAt] : [])] : [];
    const previousRange = context.anchorAt ? previousReportPeriodRange(context.anchorAt, period) : null;
    const valuationJoin = reportCurrency
      ? "JOIN ledger_entry_valuations valuation ON valuation.ledger_entry_id = ledger_entries.id AND valuation.target_currency = ?"
      : "";
    const valueExpression = reportCurrency ? "valuation.converted_amount_minor" : "ledger_entries.amount_minor";
    const currencyExpression = reportCurrency ? "valuation.target_currency" : "ledger_entries.currency";
    const valuationParameters: SqlParameter[] = reportCurrency ? [reportCurrency, ...parameters] : parameters;
    const [accounts, entries, previousEntries, count, review, timeline, recentTransactions, missingValuations] = await Promise.all([
      this.accounts(reportCurrency),
      this.#database.all<{ amountMinor: string; currency: string; entryKind: string }>(
        `SELECT CAST(${valueExpression} AS TEXT) AS amountMinor, ${currencyExpression} AS currency, ledger_entries.entry_kind AS entryKind
         FROM ledger_entries ${valuationJoin} ${filter}`,
        valuationParameters,
      ),
      previousRange
        ? this.#database.all<{ amountMinor: string; currency: string; entryKind: string }>(
          `SELECT CAST(${valueExpression} AS TEXT) AS amountMinor, ${currencyExpression} AS currency, ledger_entries.entry_kind AS entryKind
           FROM ledger_entries ${valuationJoin}
           WHERE occurred_at >= substr(?, 1, 19) AND occurred_at < substr(?, 1, 19)`,
          reportCurrency ? [reportCurrency, previousRange.startAt, previousRange.endAt] : [previousRange.startAt, previousRange.endAt],
        )
        : Promise.resolve([]),
      this.#database.get<{ count: number }>(`SELECT count(*) AS count FROM ledger_entries ${filter}`, parameters),
      this.reviewCounts(),
      this.#database.all<TimelinePointView>(`
        SELECT
          substr(ledger_entries.occurred_at, 1, 7) AS month,
          ${currencyExpression} AS currency,
          CAST(SUM(CASE WHEN ledger_entries.entry_kind = 'business_income' AND ledger_entries.direction = 'credit' THEN ${valueExpression} ELSE 0 END) AS TEXT) AS incomeMinor,
          CAST(SUM(CASE WHEN ledger_entries.entry_kind IN ('tax', 'mandatory_payment', 'business_expense', 'terminal_personal_expense', 'explicit_fee') AND ledger_entries.direction = 'debit' THEN -${valueExpression} ELSE 0 END) AS TEXT) AS spendingMinor
        FROM ledger_entries ${valuationJoin}
        ${filter}
        GROUP BY substr(ledger_entries.occurred_at, 1, 7), ${currencyExpression}
        HAVING SUM(CASE WHEN ledger_entries.entry_kind = 'business_income' AND ledger_entries.direction = 'credit' THEN ${valueExpression} ELSE 0 END) <> 0
          OR SUM(CASE WHEN ledger_entries.entry_kind IN ('tax', 'mandatory_payment', 'business_expense', 'terminal_personal_expense', 'explicit_fee') AND ledger_entries.direction = 'debit' THEN -${valueExpression} ELSE 0 END) <> 0
        ORDER BY month, currency
      `, valuationParameters),
      this.transactions({ from: context.startAt ?? undefined, to: context.endAt ?? undefined, reportCurrency, limit: 6 }),
      reportCurrency
        ? this.#database.get<{ count: number }>(`
          SELECT count(*) AS count
          FROM ledger_entries entry
          WHERE ${context.startAt ? "entry.occurred_at >= substr(?, 1, 19) AND" : ""}
            ${context.endAt ? "entry.occurred_at < substr(?, 1, 19) AND" : ""}
            NOT EXISTS (
              SELECT 1 FROM ledger_entry_valuations valuation
              WHERE valuation.ledger_entry_id = entry.id AND valuation.target_currency = ?
            )
        `, [...parameters, reportCurrency])
        : Promise.resolve({ count: 0 }),
    ]);
    return {
      accounts,
      flows: consolidatedFlowView(entries),
      previousFlows: consolidatedFlowView(previousEntries),
      transactionCount: count?.count ?? 0,
      reviewCount: review.pendingMovements + review.unresolvedRows + review.rejectedRows + review.openConflicts + review.lowConfidenceCategories + review.importIssues,
      period,
      anchorAt: context.anchorAt,
      timeline,
      recentTransactions,
      missingValuationCount: missingValuations?.count ?? 0,
    };
  }

  async transactions(input: {
    id?: string;
    mode?: TransactionMode;
    sort?: TransactionSort;
    query?: string;
    accountId?: string;
    reportCurrency?: string;
    nativeCurrency?: string;
    currency?: string;
    categoryCode?: string;
    entryKind?: string;
    direction?: "debit" | "credit";
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<TransactionView[]> {
    const reportCurrency = normalizeReportCurrency(input.reportCurrency);
    const where: string[] = [];
    const parameters: SqlParameter[] = [];
    const modeWhere = transactionModeWhere(input.mode);
    if (modeWhere) where.push(modeWhere);
    if (input.id) { where.push("le.id = ?"); parameters.push(input.id); }
    if (input.query?.trim()) {
      where.push("COALESCE(le.private_description, '') GLOB ?");
      parameters.push(literalSearch(input.query.trim()));
    }
    if (input.accountId) {
      where.push("le.account_id = ?");
      parameters.push(input.accountId);
    }
    const nativeCurrency = input.nativeCurrency ?? input.currency;
    if (nativeCurrency) {
      where.push("le.currency = ?");
      parameters.push(nativeCurrency.toUpperCase());
    }
    if (input.categoryCode === "uncategorized") {
      where.push("c.id IS NULL AND a.owner_scope = 'PERSONAL' AND le.entry_kind = 'terminal_personal_expense' AND le.direction = 'debit'");
    } else if (input.categoryCode) {
      where.push("(c.code = ? OR parent_category.code = ?)");
      parameters.push(input.categoryCode, input.categoryCode);
    }
    if (input.entryKind) {
      where.push("le.entry_kind = ?");
      parameters.push(input.entryKind);
    }
    if (input.direction) {
      where.push("le.direction = ?");
      parameters.push(input.direction);
    }
    if (input.from) {
      where.push("le.occurred_at >= substr(?, 1, 19)");
      parameters.push(input.from);
    }
    if (input.to) {
      where.push("le.occurred_at < substr(?, 1, 19)");
      parameters.push(input.to);
    }
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 200);
    const offset = Math.max(input.offset ?? 0, 0);
    parameters.push(limit, offset);
    // Decimal text magnitude avoids floating point AND abs(INT64_MIN) overflow.
    const magnitude = `ltrim(CAST(${reportCurrency ? "sort_valuation.converted_amount_minor" : "le.amount_minor"} AS TEXT), '-')`;
    const order = input.sort === "largest"
      ? `${magnitude} IS NULL, length(${magnitude}) DESC, ${magnitude} DESC, le.occurred_at DESC, le.id DESC`
      : input.sort === "oldest" ? "le.occurred_at ASC, le.id ASC" : "le.occurred_at DESC, le.id DESC";
    const rows = await this.#database.all<Omit<TransactionView, "needsReview" | "reportAmountMinor" | "reportCurrency" | "valuationMissing" | "valuations"> & { needsReview: number }>(`
      SELECT
        le.id,
        le.account_id AS accountId,
        a.display_name AS accountName,
        a.owner_scope AS ownerScope,
        CAST(le.amount_minor AS TEXT) AS amountMinor,
        le.currency,
        le.direction,
        le.occurred_at AS occurredAt,
        le.entry_kind AS entryKind,
        le.private_description AS description,
        (SELECT count(*) FROM transaction_evidence te WHERE te.ledger_entry_id = le.id) AS evidenceCount,
        c.code AS categoryCode,
        c.display_name AS categoryName,
        ca.method AS categoryMethod,
        COALESCE(ca.needs_review, 0) AS needsReview,
        movement.id AS movementGroupId,
        movement.status AS movementStatus,
        movement.evidence_kind AS movementEvidenceKind,
        CASE WHEN movement.id IS NULL THEN 0 ELSE (
          SELECT count(*) FROM cost_components component WHERE component.movement_group_id = movement.id
        ) END AS movementCostCount
      FROM ledger_entries le
      JOIN accounts a ON a.id = le.account_id
      LEFT JOIN category_assignments ca ON ca.rowid = (
        SELECT inner_ca.rowid FROM category_assignments inner_ca
        WHERE inner_ca.ledger_entry_id = le.id
        ORDER BY inner_ca.assigned_at DESC, inner_ca.rowid DESC
        LIMIT 1
      )
      LEFT JOIN categories c ON c.id = ca.category_id
      LEFT JOIN categories parent_category ON parent_category.id = c.parent_id
      LEFT JOIN movement_legs movement_leg ON movement_leg.ledger_entry_id = le.id
      LEFT JOIN movement_groups movement ON movement.id = movement_leg.movement_group_id
      ${reportCurrency ? "LEFT JOIN ledger_entry_valuations sort_valuation ON sort_valuation.ledger_entry_id = le.id AND sort_valuation.target_currency = ?" : ""}
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY ${order}
      LIMIT ? OFFSET ?
    `, reportCurrency ? [reportCurrency, ...parameters] : parameters);
    const valuationsByEntry = await this.#transactionValuations(rows.map(({ id }) => id));
    return rows.map((row) => {
      const valuations = valuationsByEntry.get(row.id) ?? [];
      const reporting = reportCurrency ? valuations.find(({ currency }) => currency === reportCurrency) : undefined;
      return {
        ...row,
        needsReview: row.needsReview === 1,
        reportAmountMinor: reportCurrency ? reporting?.amountMinor ?? null : row.amountMinor,
        reportCurrency: reportCurrency ?? row.currency,
        valuationMissing: Boolean(reportCurrency && !reporting),
        valuations,
      };
    });
  }

  async transactionPage(input: {
    mode?: TransactionMode;
    sort?: TransactionSort;
    query?: string;
    accountId?: string;
    reportCurrency?: string;
    nativeCurrency?: string;
    currency?: string;
    categoryCode?: string;
    entryKind?: string;
    direction?: "debit" | "credit";
    from?: string;
    to?: string;
    period?: ReportPeriod;
    page?: number;
    pageSize?: number;
  } = {}): Promise<TransactionPageView> {
    const pageSize = Math.min(Math.max(input.pageSize ?? 50, 1), 100);
    const requestedPage = Math.max(input.page ?? 1, 1);
    const periodContext = input.period ? await this.#periodContext(parseReportPeriod(input.period)) : null;
    const from = input.from ?? periodContext?.startAt ?? undefined;
    const to = input.to ?? periodContext?.endAt ?? undefined;
    const where: string[] = [];
    const parameters: SqlParameter[] = [];
    const modeWhere = transactionModeWhere(input.mode);
    if (modeWhere) where.push(modeWhere);
    if (input.query?.trim()) {
      where.push("COALESCE(le.private_description, '') GLOB ?");
      parameters.push(literalSearch(input.query.trim()));
    }
    if (input.accountId) {
      where.push("le.account_id = ?");
      parameters.push(input.accountId);
    }
    const nativeCurrency = input.nativeCurrency ?? input.currency;
    if (nativeCurrency) {
      where.push("le.currency = ?");
      parameters.push(nativeCurrency.toUpperCase());
    }
    if (input.categoryCode === "uncategorized") {
      where.push("c.id IS NULL AND a.owner_scope = 'PERSONAL' AND le.entry_kind = 'terminal_personal_expense' AND le.direction = 'debit'");
    } else if (input.categoryCode) {
      where.push("(c.code = ? OR parent_category.code = ?)");
      parameters.push(input.categoryCode, input.categoryCode);
    }
    if (input.entryKind) {
      where.push("le.entry_kind = ?");
      parameters.push(input.entryKind);
    }
    if (input.direction) {
      where.push("le.direction = ?");
      parameters.push(input.direction);
    }
    if (from) {
      where.push("le.occurred_at >= substr(?, 1, 19)");
      parameters.push(from);
    }
    if (to) {
      where.push("le.occurred_at < substr(?, 1, 19)");
      parameters.push(to);
    }
    const totalRow = await this.#database.get<{ count: number }>(`
      SELECT count(*) AS count
      FROM ledger_entries le
      JOIN accounts a ON a.id = le.account_id
      LEFT JOIN category_assignments ca ON ca.rowid = (
        SELECT inner_ca.rowid FROM category_assignments inner_ca
        WHERE inner_ca.ledger_entry_id = le.id
        ORDER BY inner_ca.assigned_at DESC, inner_ca.rowid DESC
        LIMIT 1
      )
      LEFT JOIN categories c ON c.id = ca.category_id
      LEFT JOIN categories parent_category ON parent_category.id = c.parent_id
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
    `, parameters);
    const total = totalRow?.count ?? 0;
    const pageCount = Math.max(Math.ceil(total / pageSize), 1);
    const page = Math.min(requestedPage, pageCount);
    const items = await this.transactions({
      mode: input.mode,
      sort: input.sort,
      query: input.query,
      accountId: input.accountId,
      reportCurrency: input.reportCurrency,
      nativeCurrency,
      categoryCode: input.categoryCode,
      entryKind: input.entryKind,
      direction: input.direction,
      from,
      to,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });
    return { items, total, page, pageSize, pageCount };
  }

  async transactionById(id: string, reportCurrency: string): Promise<TransactionView | null> {
    return (await this.transactions({ id, reportCurrency, limit: 1 }))[0] ?? null;
  }

  async #transactionValuations(entryIds: readonly string[]): Promise<Map<string, TransactionValuationView[]>> {
    const output = new Map<string, TransactionValuationView[]>();
    if (entryIds.length === 0) return output;
    const placeholders = entryIds.map(() => "?").join(", ");
    const rows = await this.#database.all<TransactionValuationView & { entryId: string }>(`
      SELECT ledger_entry_id AS entryId, target_currency AS currency,
        CAST(converted_amount_minor AS TEXT) AS amountMinor, rate_text AS rate,
        source, publication_date AS publicationDate
      FROM ledger_entry_valuations
      WHERE ledger_entry_id IN (${placeholders})
      ORDER BY ledger_entry_id, CASE target_currency WHEN 'UAH' THEN 0 WHEN 'EUR' THEN 1 WHEN 'USD' THEN 2 ELSE 3 END
    `, entryIds);
    for (const { entryId, ...valuation } of rows) {
      const values = output.get(entryId) ?? [];
      values.push(valuation);
      output.set(entryId, values);
    }
    return output;
  }

  async categoryAnalytics(periodInput: string | undefined = "all", reportCurrencyInput?: string): Promise<CategoryAnalyticsView> {
    const period = parseReportPeriod(periodInput);
    const reportCurrency = normalizeReportCurrency(reportCurrencyInput);
    const context = await this.#periodContext(period);
    if (reportCurrency) return this.#categoryAnalyticsReportCurrency(period, context, reportCurrency);
    const dateFilter = context.startAt ? `AND le.occurred_at >= substr(?, 1, 19)${context.endAt ? " AND le.occurred_at < substr(?, 1, 19)" : ""}` : "";
    const parameters = context.startAt ? [context.startAt, ...(context.endAt ? [context.endAt] : [])] : [];
    const previousRange = context.anchorAt ? previousReportPeriodRange(context.anchorAt, period) : null;
    const previousTotalsPromise = previousRange
      ? this.#database.all<CategoryTotalView>(`
        WITH latest_categories AS (
          SELECT ca.ledger_entry_id, ca.category_id
          FROM category_assignments ca
          WHERE ca.rowid = (
            SELECT inner_ca.rowid FROM category_assignments inner_ca
            WHERE inner_ca.ledger_entry_id = ca.ledger_entry_id
            ORDER BY inner_ca.assigned_at DESC, inner_ca.rowid DESC
            LIMIT 1
          )
        )
        SELECT
          COALESCE(parent.code, category.code) AS categoryCode,
          COALESCE(parent.display_name, category.display_name) AS categoryName,
          le.currency,
          CAST(SUM(-le.amount_minor) AS TEXT) AS amountMinor,
          count(*) AS transactionCount
        FROM ledger_entries le
        JOIN accounts account ON account.id = le.account_id
        JOIN latest_categories latest ON latest.ledger_entry_id = le.id
        JOIN categories category ON category.id = latest.category_id
        LEFT JOIN categories parent ON parent.id = category.parent_id
        WHERE account.owner_scope = 'PERSONAL'
          AND le.direction = 'debit'
          AND le.entry_kind = 'terminal_personal_expense'
          AND le.occurred_at >= substr(?, 1, 19)
          AND le.occurred_at < substr(?, 1, 19)
        GROUP BY COALESCE(parent.code, category.code), COALESCE(parent.display_name, category.display_name), le.currency
        ORDER BY le.currency, SUM(-le.amount_minor) DESC, categoryName
      `, [previousRange.startAt, previousRange.endAt])
      : Promise.resolve([]);
    const [totals, previousTotals, trends, coverage] = await Promise.all([
      this.#database.all<CategoryTotalView>(`
        WITH latest_categories AS (
          SELECT ca.ledger_entry_id, ca.category_id
          FROM category_assignments ca
          WHERE ca.rowid = (
            SELECT inner_ca.rowid FROM category_assignments inner_ca
            WHERE inner_ca.ledger_entry_id = ca.ledger_entry_id
            ORDER BY inner_ca.assigned_at DESC, inner_ca.rowid DESC
            LIMIT 1
          )
        )
        SELECT
          COALESCE(parent.code, category.code) AS categoryCode,
          COALESCE(parent.display_name, category.display_name) AS categoryName,
          le.currency,
          CAST(SUM(-le.amount_minor) AS TEXT) AS amountMinor,
          count(*) AS transactionCount
        FROM ledger_entries le
        JOIN accounts account ON account.id = le.account_id
        JOIN latest_categories latest ON latest.ledger_entry_id = le.id
        JOIN categories category ON category.id = latest.category_id
        LEFT JOIN categories parent ON parent.id = category.parent_id
        WHERE account.owner_scope = 'PERSONAL'
          AND le.direction = 'debit'
          AND le.entry_kind = 'terminal_personal_expense'
          ${dateFilter}
        GROUP BY COALESCE(parent.code, category.code), COALESCE(parent.display_name, category.display_name), le.currency
        ORDER BY le.currency, SUM(-le.amount_minor) DESC, categoryName
      `, parameters),
      previousTotalsPromise,
      this.#database.all<CategoryTrendView>(`
        WITH latest_categories AS (
          SELECT ca.ledger_entry_id, ca.category_id
          FROM category_assignments ca
          WHERE ca.rowid = (
            SELECT inner_ca.rowid FROM category_assignments inner_ca
            WHERE inner_ca.ledger_entry_id = ca.ledger_entry_id
            ORDER BY inner_ca.assigned_at DESC, inner_ca.rowid DESC
            LIMIT 1
          )
        )
        SELECT
          substr(le.occurred_at, 1, 7) AS month,
          COALESCE(parent.code, category.code) AS categoryCode,
          COALESCE(parent.display_name, category.display_name) AS categoryName,
          le.currency,
          CAST(SUM(-le.amount_minor) AS TEXT) AS amountMinor,
          count(*) AS transactionCount
        FROM ledger_entries le
        JOIN accounts account ON account.id = le.account_id
        JOIN latest_categories latest ON latest.ledger_entry_id = le.id
        JOIN categories category ON category.id = latest.category_id
        LEFT JOIN categories parent ON parent.id = category.parent_id
        WHERE account.owner_scope = 'PERSONAL'
          AND le.direction = 'debit'
          AND le.entry_kind = 'terminal_personal_expense'
          ${dateFilter}
        GROUP BY substr(le.occurred_at, 1, 7), COALESCE(parent.code, category.code), COALESCE(parent.display_name, category.display_name), le.currency
        ORDER BY month, le.currency, SUM(-le.amount_minor) DESC
      `, parameters),
      this.#database.get<{ terminalPersonalEntries: number; categorizedTerminalEntries: number }>(`
        SELECT
          count(*) AS terminalPersonalEntries,
          SUM(CASE WHEN EXISTS (SELECT 1 FROM category_assignments ca WHERE ca.ledger_entry_id = le.id) THEN 1 ELSE 0 END) AS categorizedTerminalEntries
        FROM ledger_entries le
        JOIN accounts account ON account.id = le.account_id
        WHERE account.owner_scope = 'PERSONAL'
          AND le.direction = 'debit'
          AND le.entry_kind = 'terminal_personal_expense'
          ${dateFilter}
      `, parameters),
    ]);
    return {
      period,
      anchorAt: context.anchorAt,
      totals,
      previousTotals,
      trends,
      terminalPersonalEntries: coverage?.terminalPersonalEntries ?? 0,
      categorizedTerminalEntries: coverage?.categorizedTerminalEntries ?? 0,
    };
  }

  async #categoryAnalyticsReportCurrency(
    period: ReportPeriod,
    context: { anchorAt: string | null; startAt: string | null; endAt: string | null },
    reportCurrency: string,
  ): Promise<CategoryAnalyticsView> {
    const readRows = (from?: string | null, to?: string | null): Promise<CategoryLedgerRow[]> => {
      const conditions: string[] = [];
      const parameters: SqlParameter[] = [reportCurrency, reportCurrency];
      if (from) {
        conditions.push("entry.occurred_at >= substr(?, 1, 19)");
        parameters.push(from);
      }
      if (to) {
        conditions.push("entry.occurred_at < substr(?, 1, 19)");
        parameters.push(to);
      }
      return this.#database.all<CategoryLedgerRow>(`
        WITH latest_categories AS (
          SELECT assignment.ledger_entry_id, assignment.category_id
          FROM category_assignments assignment
          WHERE assignment.rowid = (
            SELECT inner_assignment.rowid FROM category_assignments inner_assignment
            WHERE inner_assignment.ledger_entry_id = assignment.ledger_entry_id
            ORDER BY inner_assignment.assigned_at DESC, inner_assignment.rowid DESC
            LIMIT 1
          )
        )
        SELECT
          COALESCE(parent.code, category.code, 'uncategorized') AS categoryCode,
          COALESCE(parent.display_name, category.display_name, 'Без категорії') AS categoryName,
          substr(entry.occurred_at, 1, 7) AS month,
          CASE WHEN entry.currency = ? THEN CAST(entry.amount_minor AS TEXT)
            ELSE CAST(valuation.converted_amount_minor AS TEXT) END AS amountMinor
        FROM ledger_entries entry
        JOIN accounts account ON account.id = entry.account_id
        LEFT JOIN latest_categories latest ON latest.ledger_entry_id = entry.id
        LEFT JOIN categories category ON category.id = latest.category_id
        LEFT JOIN categories parent ON parent.id = category.parent_id
        LEFT JOIN ledger_entry_valuations valuation ON valuation.ledger_entry_id = entry.id AND valuation.target_currency = ?
        WHERE account.owner_scope = 'PERSONAL'
          AND entry.direction = 'debit'
          AND entry.entry_kind = 'terminal_personal_expense'
          ${conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : ""}
        ORDER BY entry.occurred_at, entry.id
      `, parameters);
    };
    const previousRange = context.anchorAt ? previousReportPeriodRange(context.anchorAt, period) : null;
    const [rows, previousRows, coverage] = await Promise.all([
      readRows(context.startAt, context.endAt),
      previousRange ? readRows(previousRange.startAt, previousRange.endAt) : Promise.resolve([]),
      this.#database.get<{ terminalPersonalEntries: number; categorizedTerminalEntries: number }>(`
        SELECT
          count(*) AS terminalPersonalEntries,
          SUM(CASE WHEN EXISTS (SELECT 1 FROM category_assignments assignment WHERE assignment.ledger_entry_id = entry.id) THEN 1 ELSE 0 END) AS categorizedTerminalEntries
        FROM ledger_entries entry
        JOIN accounts account ON account.id = entry.account_id
        WHERE account.owner_scope = 'PERSONAL'
          AND entry.direction = 'debit'
          AND entry.entry_kind = 'terminal_personal_expense'
          ${context.startAt ? "AND entry.occurred_at >= substr(?, 1, 19)" : ""}
          ${context.endAt ? "AND entry.occurred_at < substr(?, 1, 19)" : ""}
      `, [...(context.startAt ? [context.startAt] : []), ...(context.endAt ? [context.endAt] : [])]),
    ]);
    return {
      period,
      anchorAt: context.anchorAt,
      totals: aggregateCategoryRows(rows, reportCurrency),
      previousTotals: aggregateCategoryRows(previousRows, reportCurrency),
      trends: aggregateCategoryTrends(rows, reportCurrency),
      missingValuationCount: rows.filter(row => row.amountMinor === null).length,
      terminalPersonalEntries: coverage?.terminalPersonalEntries ?? 0,
      categorizedTerminalEntries: coverage?.categorizedTerminalEntries ?? 0,
    };
  }

  async moneyFlow(periodInput: string | undefined = "all", reportCurrencyInput?: string): Promise<MoneyFlowOverviewView> {
    const period = parseReportPeriod(periodInput);
    const reportCurrency = normalizeReportCurrency(reportCurrencyInput);
    const context = await this.#periodContext(period);
    const movementDateFilter = context.startAt ? `AND route.occurredAt >= substr(?, 1, 19)${context.endAt ? " AND route.occurredAt < substr(?, 1, 19)" : ""}` : "";
    const entryDateFilter = context.startAt ? `AND le.occurred_at >= substr(?, 1, 19)${context.endAt ? " AND le.occurred_at < substr(?, 1, 19)" : ""}` : "";
    const costDateFilter = context.startAt ? `AND cost.occurredAt >= substr(?, 1, 19)${context.endAt ? " AND cost.occurredAt < substr(?, 1, 19)" : ""}` : "";
    const parameters: SqlParameter[] = context.startAt ? [context.startAt, ...(context.endAt ? [context.endAt] : [])] : [];
    const transferParameters: SqlParameter[] = reportCurrency
      ? [reportCurrency, reportCurrency, reportCurrency, reportCurrency, ...parameters]
      : parameters;
    const entryParameters: SqlParameter[] = reportCurrency ? [reportCurrency, ...parameters] : parameters;
    const costParameters: SqlParameter[] = reportCurrency ? [reportCurrency, reportCurrency, ...parameters] : parameters;
    const [transfers, terminalSpending, businessUses, unlinkedRoutes, costs, coverage] = await Promise.all([
      this.#database.all<MovementTransferAggregateView>(`
        WITH debits AS (
          SELECT
            ml.movement_group_id AS groupId,
            account.id AS accountId,
            account.display_name AS accountName,
            account.owner_scope AS ownerScope,
            le.currency,
            -le.amount_minor AS amountMinor,
            ${reportCurrency ? "CASE WHEN valuation.converted_amount_minor IS NULL THEN NULL ELSE abs(valuation.converted_amount_minor) END" : "NULL"} AS reportAmountMinor,
            ${reportCurrency ? "CASE WHEN valuation.ledger_entry_id IS NULL THEN 1 ELSE 0 END" : "0"} AS valuationMissing,
            le.occurred_at AS occurredAt,
            ROW_NUMBER() OVER (PARTITION BY ml.movement_group_id ORDER BY ml.position, ml.rowid) AS rank
          FROM movement_legs ml
          JOIN ledger_entries le ON le.id = ml.ledger_entry_id
          JOIN accounts account ON account.id = le.account_id
          ${reportCurrency ? "LEFT JOIN ledger_entry_valuations valuation ON valuation.ledger_entry_id = le.id AND valuation.target_currency = ?" : ""}
          WHERE le.direction = 'debit' AND ml.leg_kind <> 'explicit_fee'
        ),
        credits AS (
          SELECT
            ml.movement_group_id AS groupId,
            account.id AS accountId,
            account.display_name AS accountName,
            account.owner_scope AS ownerScope,
            le.currency,
            le.amount_minor AS amountMinor,
            ${reportCurrency ? "valuation.converted_amount_minor" : "NULL"} AS reportAmountMinor,
            ${reportCurrency ? "CASE WHEN valuation.ledger_entry_id IS NULL THEN 1 ELSE 0 END" : "0"} AS valuationMissing,
            ROW_NUMBER() OVER (PARTITION BY ml.movement_group_id ORDER BY ml.position, ml.rowid) AS rank
          FROM movement_legs ml
          JOIN ledger_entries le ON le.id = ml.ledger_entry_id
          JOIN accounts account ON account.id = le.account_id
          ${reportCurrency ? "LEFT JOIN ledger_entry_valuations valuation ON valuation.ledger_entry_id = le.id AND valuation.target_currency = ?" : ""}
          WHERE le.direction = 'credit'
        ),
        paired_routes AS (
          SELECT
            movement.id AS groupId,
            debit.accountId AS sourceAccountId,
            credit.accountId AS destinationAccountId,
            movement.evidence_kind AS evidenceKind,
            debit.accountName AS fromAccountName,
            debit.ownerScope AS fromOwnerScope,
            credit.accountName AS toAccountName,
            credit.ownerScope AS toOwnerScope,
            debit.currency AS sourceCurrency,
            credit.currency AS destinationCurrency,
            debit.amountMinor AS sourceAmountMinor,
            credit.amountMinor AS destinationAmountMinor,
            debit.reportAmountMinor AS sourceReportAmountMinor,
            credit.reportAmountMinor AS destinationReportAmountMinor,
            debit.valuationMissing AS sourceValuationMissing,
            credit.valuationMissing AS destinationValuationMissing,
            debit.occurredAt
          FROM movement_groups movement
          JOIN debits debit ON debit.groupId = movement.id AND debit.rank = 1
          JOIN credits credit ON credit.groupId = movement.id AND credit.rank = 1
          WHERE movement.status IN ('confirmed', 'reconciled')
        ),
        provider_fx_routes AS (
          SELECT
            movement.id AS groupId,
            NULL AS sourceAccountId,
            account.id AS destinationAccountId,
            movement.evidence_kind AS evidenceKind,
            'ФОП ' || conversion.sold_currency || ' · валютний пул' AS fromAccountName,
            'SOLE_PROPRIETOR' AS fromOwnerScope,
            account.display_name AS toAccountName,
            account.owner_scope AS toOwnerScope,
            conversion.sold_currency AS sourceCurrency,
            entry.currency AS destinationCurrency,
            conversion.sold_amount_minor AS sourceAmountMinor,
            entry.amount_minor AS destinationAmountMinor,
            ${reportCurrency ? "source_valuation.converted_amount_minor" : "NULL"} AS sourceReportAmountMinor,
            ${reportCurrency ? "valuation.converted_amount_minor" : "NULL"} AS destinationReportAmountMinor,
            ${reportCurrency ? "CASE WHEN source_valuation.fx_conversion_id IS NULL THEN 1 ELSE 0 END" : "0"} AS sourceValuationMissing,
            ${reportCurrency ? "CASE WHEN valuation.ledger_entry_id IS NULL THEN 1 ELSE 0 END" : "0"} AS destinationValuationMissing,
            entry.occurred_at AS occurredAt
          FROM movement_groups movement
          JOIN fx_conversions conversion ON conversion.movement_group_id = movement.id
          JOIN movement_legs leg ON leg.movement_group_id = movement.id
          JOIN ledger_entries entry ON entry.id = leg.ledger_entry_id AND entry.direction = 'credit'
          JOIN accounts account ON account.id = entry.account_id
          ${reportCurrency ? "LEFT JOIN fx_conversion_source_valuations source_valuation ON source_valuation.fx_conversion_id = conversion.id AND source_valuation.target_currency = ?" : ""}
          ${reportCurrency ? "LEFT JOIN ledger_entry_valuations valuation ON valuation.ledger_entry_id = entry.id AND valuation.target_currency = ?" : ""}
          WHERE movement.status IN ('confirmed', 'reconciled')
            AND movement.evidence_kind = 'provider_fx_description'
        ),
        routes AS (
          SELECT * FROM paired_routes
          UNION ALL
          SELECT * FROM provider_fx_routes
        )
        SELECT
          route.fromAccountName,
          route.sourceAccountId,
          route.destinationAccountId,
          route.fromOwnerScope,
          route.toAccountName,
          route.toOwnerScope,
          route.sourceCurrency,
          route.destinationCurrency,
          CAST(SUM(route.sourceAmountMinor) AS TEXT) AS sourceAmountMinor,
          CAST(SUM(route.destinationAmountMinor) AS TEXT) AS destinationAmountMinor,
          ${reportCurrency ? "CASE WHEN SUM(route.sourceValuationMissing) = 0 THEN CAST(SUM(route.sourceReportAmountMinor) AS TEXT) ELSE NULL END" : "NULL"} AS sourceReportAmountMinor,
          ${reportCurrency ? "CASE WHEN SUM(route.destinationValuationMissing) = 0 THEN CAST(SUM(route.destinationReportAmountMinor) AS TEXT) ELSE NULL END" : "NULL"} AS destinationReportAmountMinor,
          SUM(route.sourceValuationMissing) AS sourceValuationMissingCount,
          SUM(route.destinationValuationMissing) AS destinationValuationMissingCount,
          count(*) AS groupCount,
          SUM(CASE WHEN route.evidenceKind <> 'manual' THEN 1 ELSE 0 END) AS automaticGroupCount
        FROM routes route
        WHERE 1 = 1 ${movementDateFilter}
        GROUP BY route.sourceAccountId, route.destinationAccountId, route.fromAccountName, route.fromOwnerScope, route.toAccountName, route.toOwnerScope, route.sourceCurrency, route.destinationCurrency
        ORDER BY SUM(route.sourceAmountMinor) DESC, route.fromAccountName, route.toAccountName
      `, transferParameters),
      this.#database.all<TerminalSpendingAggregateView>(`
        WITH latest_categories AS (
          SELECT ca.ledger_entry_id, ca.category_id
          FROM category_assignments ca
          WHERE ca.rowid = (
            SELECT inner_ca.rowid FROM category_assignments inner_ca
            WHERE inner_ca.ledger_entry_id = ca.ledger_entry_id
            ORDER BY inner_ca.assigned_at DESC, inner_ca.rowid DESC
            LIMIT 1
          )
        )
        SELECT
          account.display_name AS accountName,
          COALESCE(parent.code, category.code) AS categoryCode,
          COALESCE(parent.display_name, category.display_name) AS categoryName,
          le.currency,
          CAST(SUM(-le.amount_minor) AS TEXT) AS amountMinor,
          ${reportCurrency ? "CASE WHEN SUM(CASE WHEN valuation.ledger_entry_id IS NULL THEN 1 ELSE 0 END) = 0 THEN CAST(SUM(abs(valuation.converted_amount_minor)) AS TEXT) ELSE NULL END" : "NULL"} AS reportAmountMinor,
          ${reportCurrency ? "SUM(CASE WHEN valuation.ledger_entry_id IS NULL THEN 1 ELSE 0 END)" : "0"} AS valuationMissingCount,
          count(*) AS transactionCount
        FROM ledger_entries le
        JOIN accounts account ON account.id = le.account_id
        JOIN latest_categories latest ON latest.ledger_entry_id = le.id
        JOIN categories category ON category.id = latest.category_id
        LEFT JOIN categories parent ON parent.id = category.parent_id
        ${reportCurrency ? "LEFT JOIN ledger_entry_valuations valuation ON valuation.ledger_entry_id = le.id AND valuation.target_currency = ?" : ""}
        WHERE account.owner_scope = 'PERSONAL'
          AND le.direction = 'debit'
          AND le.entry_kind = 'terminal_personal_expense'
          ${entryDateFilter}
        GROUP BY account.display_name, COALESCE(parent.code, category.code), COALESCE(parent.display_name, category.display_name), le.currency
        ORDER BY SUM(-le.amount_minor) DESC, accountName, categoryName
      `, entryParameters),
      this.#database.all<BusinessUseAggregateView>(`
        SELECT
          le.entry_kind AS entryKind,
          le.currency,
          CAST(SUM(-le.amount_minor) AS TEXT) AS amountMinor,
          ${reportCurrency ? "CASE WHEN SUM(CASE WHEN valuation.ledger_entry_id IS NULL THEN 1 ELSE 0 END) = 0 THEN CAST(SUM(abs(valuation.converted_amount_minor)) AS TEXT) ELSE NULL END" : "NULL"} AS reportAmountMinor,
          ${reportCurrency ? "SUM(CASE WHEN valuation.ledger_entry_id IS NULL THEN 1 ELSE 0 END)" : "0"} AS valuationMissingCount,
          count(*) AS transactionCount
        FROM ledger_entries le
        JOIN accounts account ON account.id = le.account_id
        ${reportCurrency ? "LEFT JOIN ledger_entry_valuations valuation ON valuation.ledger_entry_id = le.id AND valuation.target_currency = ?" : ""}
        WHERE account.owner_scope = 'SOLE_PROPRIETOR'
          AND le.direction = 'debit'
          AND le.entry_kind IN ('tax', 'mandatory_payment', 'business_expense')
          ${entryDateFilter}
        GROUP BY le.entry_kind, le.currency
        ORDER BY le.currency, SUM(-le.amount_minor) DESC
      `, entryParameters),
      this.#database.all<UnlinkedTransferAggregateView>(`
        SELECT
          le.direction,
          account.display_name AS accountName,
          account.owner_scope AS ownerScope,
          le.currency,
          CAST(SUM(abs(le.amount_minor)) AS TEXT) AS amountMinor,
          ${reportCurrency ? "CASE WHEN SUM(CASE WHEN valuation.ledger_entry_id IS NULL THEN 1 ELSE 0 END) = 0 THEN CAST(SUM(abs(valuation.converted_amount_minor)) AS TEXT) ELSE NULL END" : "NULL"} AS reportAmountMinor,
          ${reportCurrency ? "SUM(CASE WHEN valuation.ledger_entry_id IS NULL THEN 1 ELSE 0 END)" : "0"} AS valuationMissingCount,
          count(*) AS transactionCount
        FROM ledger_entries le
        JOIN accounts account ON account.id = le.account_id
        ${reportCurrency ? "LEFT JOIN ledger_entry_valuations valuation ON valuation.ledger_entry_id = le.id AND valuation.target_currency = ?" : ""}
        WHERE le.entry_kind IN ('unlinked_transfer_in', 'unlinked_transfer_out')
          ${entryDateFilter}
        GROUP BY le.direction, account.display_name, account.owner_scope, le.currency
        ORDER BY le.currency, SUM(abs(le.amount_minor)) DESC, accountName
      `, entryParameters),
      this.#database.all<Omit<CostAggregateView, "estimated"> & { estimated: number }>(`
        WITH movement_dates AS (
          SELECT ml.movement_group_id AS groupId, MIN(le.occurred_at) AS occurredAt
          FROM movement_legs ml JOIN ledger_entries le ON le.id = ml.ledger_entry_id
          GROUP BY ml.movement_group_id
        ), combined_costs AS (
          SELECT component.method, component.currency, component.amount_minor AS amountMinor,
            component.estimated, movement.occurredAt,
            ${reportCurrency ? "component_valuation.converted_amount_minor" : "NULL"} AS reportAmountMinor,
            ${reportCurrency ? "CASE WHEN component_valuation.cost_component_id IS NULL THEN 1 ELSE 0 END" : "0"} AS valuationMissing
          FROM cost_components component
          JOIN movement_dates movement ON movement.groupId = component.movement_group_id
          ${reportCurrency ? "LEFT JOIN cost_component_valuations component_valuation ON component_valuation.cost_component_id = component.id AND component_valuation.target_currency = ?" : ""}
          UNION ALL
          SELECT 'explicit_statement_fee' AS method, le.currency, -le.amount_minor AS amountMinor,
            0 AS estimated, le.occurred_at AS occurredAt,
            ${reportCurrency ? "CASE WHEN entry_valuation.converted_amount_minor IS NULL THEN NULL ELSE abs(entry_valuation.converted_amount_minor) END" : "NULL"} AS reportAmountMinor,
            ${reportCurrency ? "CASE WHEN entry_valuation.ledger_entry_id IS NULL THEN 1 ELSE 0 END" : "0"} AS valuationMissing
          FROM ledger_entries le
          ${reportCurrency ? "LEFT JOIN ledger_entry_valuations entry_valuation ON entry_valuation.ledger_entry_id = le.id AND entry_valuation.target_currency = ?" : ""}
          WHERE le.entry_kind = 'explicit_fee'
            AND le.direction = 'debit'
            AND NOT EXISTS (SELECT 1 FROM movement_legs leg WHERE leg.ledger_entry_id = le.id)
        )
        SELECT
          cost.method,
          cost.currency,
          CAST(SUM(cost.amountMinor) AS TEXT) AS amountMinor,
          ${reportCurrency ? "CASE WHEN SUM(cost.valuationMissing) = 0 THEN CAST(SUM(cost.reportAmountMinor) AS TEXT) ELSE NULL END" : "NULL"} AS reportAmountMinor,
          SUM(cost.valuationMissing) AS valuationMissingCount,
          cost.estimated,
          count(*) AS componentCount
        FROM combined_costs cost
        WHERE 1 = 1 ${costDateFilter}
        GROUP BY cost.method, cost.currency, cost.estimated
        ORDER BY cost.currency, SUM(cost.amountMinor) DESC, cost.method
      `, costParameters),
      this.#database.get<{ confirmedGroups: number; automaticGroups: number; rejectedCandidates: number; unlinkedTransfers: number; linkedLegs: number }>(`
        SELECT
          (SELECT count(*) FROM movement_groups WHERE status IN ('confirmed', 'reconciled')) AS confirmedGroups,
          (SELECT count(*) FROM movement_groups WHERE status IN ('confirmed', 'reconciled') AND evidence_kind <> 'manual') AS automaticGroups,
          (SELECT count(*) FROM movement_legs) AS linkedLegs,
          (SELECT count(*) FROM movement_candidates WHERE status = 'rejected') AS rejectedCandidates,
          (SELECT count(*) FROM ledger_entries WHERE entry_kind IN ('unlinked_transfer_in', 'unlinked_transfer_out')) AS unlinkedTransfers
      `),
    ]);
    const missingValuationCount = reportCurrency
      ? transfers.reduce(
        (sum, route) => sum + (route.sourceValuationMissingCount ?? 0) + (route.destinationValuationMissingCount ?? 0),
        0,
      ) + [...terminalSpending, ...businessUses, ...unlinkedRoutes, ...costs]
        .reduce((sum, aggregate) => sum + (aggregate.valuationMissingCount ?? 0), 0)
      : 0;
    const reportedTransfers = transfers.map(({
      sourceReportAmountMinor,
      destinationReportAmountMinor,
      sourceValuationMissingCount,
      destinationValuationMissingCount,
      ...transfer
    }) => reportCurrency
      ? {
        ...transfer,
        reportCurrency,
        sourceReportAmountMinor: sourceReportAmountMinor ?? null,
        destinationReportAmountMinor: destinationReportAmountMinor ?? null,
        sourceValuationMissingCount: sourceValuationMissingCount ?? 0,
        destinationValuationMissingCount: destinationValuationMissingCount ?? 0,
      }
      : transfer);
    const addAggregateReporting = <T extends {
      reportAmountMinor?: string | null;
      reportCurrency?: string | null;
      valuationMissingCount?: number;
    }>({ reportAmountMinor, valuationMissingCount, ...aggregate }: T) => reportCurrency
      ? {
        ...aggregate,
        reportAmountMinor: reportAmountMinor ?? null,
        reportCurrency,
        valuationMissingCount: valuationMissingCount ?? 0,
      }
      : aggregate;
    const reportedTerminalSpending = terminalSpending.map(addAggregateReporting);
    const reportedBusinessUses = businessUses.map(addAggregateReporting);
    const reportedUnlinkedRoutes = unlinkedRoutes.map(addAggregateReporting);
    const reportedCosts = costs.map(({ estimated, ...cost }) => ({
      ...addAggregateReporting(cost),
      estimated: estimated === 1,
    }));
    return {
      period,
      anchorAt: context.anchorAt,
      transfers: reportedTransfers,
      terminalSpending: reportedTerminalSpending,
      businessUses: reportedBusinessUses,
      unlinkedRoutes: reportedUnlinkedRoutes,
      costs: reportedCosts,
      confirmedGroups: coverage?.confirmedGroups ?? 0,
      automaticGroups: coverage?.automaticGroups ?? 0,
      rejectedCandidates: coverage?.rejectedCandidates ?? 0,
      unlinkedTransfers: coverage?.unlinkedTransfers ?? 0,
      linkedLegs: coverage?.linkedLegs ?? 0,
      ...(reportCurrency ? { missingValuationCount } : {}),
    };
  }

  async dataHealth(): Promise<DataHealthView> {
    const result = await this.#database.get<DataHealthView>(`
      SELECT
        (SELECT count(*) FROM movement_candidates WHERE status = 'pending') AS pendingCandidates,
        (SELECT count(*) FROM movement_candidates WHERE status = 'rejected') AS rejectedCandidates,
        (SELECT count(*) FROM movement_groups WHERE status IN ('confirmed', 'reconciled')) AS confirmedGroups,
        (SELECT count(*) FROM movement_groups WHERE status IN ('confirmed', 'reconciled') AND evidence_kind <> 'manual') AS automaticGroups,
        (SELECT count(*) FROM source_records WHERE row_state = 'unresolved') AS unresolvedRows,
        (SELECT count(*) FROM source_records WHERE row_state = 'rejected') AS rejectedRows,
        (SELECT count(*) FROM reconciliation_conflicts WHERE status = 'open') AS openConflicts,
        (SELECT COALESCE(sum(json_array_length(reconciliation_issues_json)), 0) FROM import_batches) AS importIssues,
        (SELECT count(*) FROM ledger_entries le JOIN accounts a ON a.id = le.account_id WHERE a.owner_scope = 'PERSONAL') AS personalEntries,
        (
          SELECT count(*) FROM ledger_entries le JOIN accounts a ON a.id = le.account_id
          WHERE a.owner_scope = 'PERSONAL'
            AND EXISTS (SELECT 1 FROM category_assignments ca WHERE ca.ledger_entry_id = le.id)
        ) AS categorizedPersonalEntries
    `);
    return result ?? {
      pendingCandidates: 0,
      rejectedCandidates: 0,
      confirmedGroups: 0,
      automaticGroups: 0,
      unresolvedRows: 0,
      rejectedRows: 0,
      openConflicts: 0,
      importIssues: 0,
      personalEntries: 0,
      categorizedPersonalEntries: 0,
    };
  }

  async reviewCounts(): Promise<ReviewCounts> {
    const row = await this.#database.get<ReviewCounts>(`
      SELECT
        (SELECT count(*) FROM movement_candidates WHERE status = 'pending') AS pendingMovements,
        (SELECT count(*) FROM source_records WHERE row_state = 'unresolved') AS unresolvedRows,
        (SELECT count(*) FROM source_records WHERE row_state = 'rejected') AS rejectedRows,
        (SELECT count(*) FROM reconciliation_conflicts WHERE status = 'open') AS openConflicts,
        (SELECT COALESCE(sum(json_array_length(reconciliation_issues_json)), 0) FROM import_batches) AS importIssues,
        (
          SELECT count(*) FROM category_assignments ca
          WHERE ca.needs_review = 1
            AND ca.rowid = (
              SELECT inner_ca.rowid FROM category_assignments inner_ca
              WHERE inner_ca.ledger_entry_id = ca.ledger_entry_id
              ORDER BY inner_ca.assigned_at DESC, inner_ca.rowid DESC
              LIMIT 1
            )
        ) AS lowConfidenceCategories
    `);
    return row ?? { pendingMovements: 0, unresolvedRows: 0, rejectedRows: 0, openConflicts: 0, lowConfidenceCategories: 0, importIssues: 0 };
  }

  async review(): Promise<ReviewView> {
    const [counts, candidates, unresolvedReasons, conflictReasons, importIssueReasons, lowConfidence, undatedObservations] = await Promise.all([
      this.reviewCounts(),
      this.#database.all<MovementCandidateView>(`
        SELECT
          mc.id,
          mc.match_kind AS matchKind,
          debit.id AS debitEntryId,
          debit_account.display_name AS debitAccountName,
          CAST(debit.amount_minor AS TEXT) AS debitAmountMinor,
          debit.currency AS debitCurrency,
          debit.occurred_at AS debitOccurredAt,
          credit.id AS creditEntryId,
          credit_account.display_name AS creditAccountName,
          CAST(credit.amount_minor AS TEXT) AS creditAmountMinor,
          credit.currency AS creditCurrency,
          credit.occurred_at AS creditOccurredAt
        FROM movement_candidates mc
        JOIN ledger_entries debit ON debit.id = mc.debit_entry_id
        JOIN accounts debit_account ON debit_account.id = debit.account_id
        JOIN ledger_entries credit ON credit.id = mc.credit_entry_id
        JOIN accounts credit_account ON credit_account.id = credit.account_id
        WHERE mc.status = 'pending'
        ORDER BY debit.occurred_at DESC, mc.id
        LIMIT 200
      `),
      this.#database.all<{ reasonCode: string; count: number }>(`
        SELECT COALESCE(reason_code, 'UNSPECIFIED') AS reasonCode, count(*) AS count
        FROM source_records
        WHERE row_state IN ('unresolved', 'rejected')
        GROUP BY COALESCE(reason_code, 'UNSPECIFIED')
        ORDER BY count DESC, reasonCode
      `),
      this.#database.all<{ reasonCode: string; count: number }>(`
        SELECT reason_code AS reasonCode, count(*) AS count
        FROM reconciliation_conflicts
        WHERE status = 'open'
        GROUP BY reason_code
        ORDER BY count DESC, reasonCode
      `),
      this.#database.all<{ reasonCode: string; count: number }>(`
        SELECT issue.value AS reasonCode, count(*) AS count
        FROM import_batches ib, json_each(ib.reconciliation_issues_json) issue
        GROUP BY issue.value
        ORDER BY count DESC, reasonCode
      `),
      this.#database.all<ReviewView["lowConfidence"][number]>(`
        SELECT
          ca.ledger_entry_id AS entryId,
          c.display_name AS categoryName,
          ca.confidence_text AS confidence,
          a.display_name AS accountName,
          le.occurred_at AS occurredAt
        FROM category_assignments ca
        JOIN categories c ON c.id = ca.category_id
        JOIN ledger_entries le ON le.id = ca.ledger_entry_id
        JOIN accounts a ON a.id = le.account_id
        WHERE ca.needs_review = 1
          AND ca.rowid = (
            SELECT inner_ca.rowid FROM category_assignments inner_ca
            WHERE inner_ca.ledger_entry_id = ca.ledger_entry_id
            ORDER BY inner_ca.assigned_at DESC, inner_ca.rowid DESC
            LIMIT 1
          )
        ORDER BY le.occurred_at DESC
        LIMIT 200
      `),
      this.#database.all<{
        sourceRecordId: string;
        reasonCode: string;
        accountName: string;
        amountMinor: string;
        currency: string;
        direction: "debit" | "credit";
        description: string | null;
        position: number;
      }>(`
        SELECT
          uo.source_record_id AS sourceRecordId,
          COALESCE(sr.reason_code, 'CONDUCTED_DATE_MISSING') AS reasonCode,
          a.display_name AS accountName,
          CAST(uo.amount_minor AS TEXT) AS amountMinor,
          uo.currency,
          uo.direction,
          uo.private_description AS description,
          uo.position
        FROM unresolved_observations uo
        JOIN source_records sr ON sr.id = uo.source_record_id
        JOIN accounts a ON a.id = uo.account_id
        WHERE uo.status = 'pending' AND sr.row_state = 'unresolved'
        ORDER BY uo.source_record_id, uo.position
        LIMIT 500
      `),
    ]);
    const undatedRowsBySource = new Map<string, ReviewView["undatedRows"][number]>();
    for (const observation of undatedObservations) {
      const row = undatedRowsBySource.get(observation.sourceRecordId) ?? {
        sourceRecordId: observation.sourceRecordId,
        reasonCode: observation.reasonCode,
        legs: [],
      };
      row.legs.push({
        accountName: observation.accountName,
        amountMinor: observation.amountMinor,
        currency: observation.currency,
        direction: observation.direction,
        description: observation.description,
      });
      undatedRowsBySource.set(observation.sourceRecordId, row);
    }
    return { counts, candidates, unresolvedReasons, conflictReasons, importIssueReasons, lowConfidence, undatedRows: [...undatedRowsBySource.values()] };
  }

  async movementChains(periodInput: string | undefined = "all", limit = 120, reportCurrencyInput?: string, costMethod?: string): Promise<MovementChainView[]> {
    return (await this.movementPage({ period: parseReportPeriod(periodInput), pageSize: limit, reportCurrency: reportCurrencyInput, costMethod })).items;
  }

  async movementById(id: string, reportCurrency: string): Promise<MovementChainView | null> {
    return (await this.movementPage({ id, period: "all", reportCurrency, pageSize: 1 })).items[0] ?? null;
  }

  async movementPage(input: MovementSearch = {}): Promise<MovementPageView> {
    const period = input.period ?? "all";
    const reportCurrency = normalizeReportCurrency(input.reportCurrency);
    const costMethod = input.costMethod;
    const context = await this.#periodContext(period);
    const pageSize = Math.min(Math.max(input.pageSize ?? 50, 1), 200);
    const parameters: SqlParameter[] = [
      ...(reportCurrency ? [reportCurrency] : []),
      ...(costMethod ? [costMethod] : []),
      ...(context.startAt ? [context.startAt] : []),
      ...(context.endAt ? [context.endAt] : []),
    ];
    const filters: string[] = [];
    if (input.id) { filters.push("id = ?"); parameters.push(input.id); }
    if (input.route) for (const column of ["sourceAccountId", "destinationAccountId", "sourceCurrency", "destinationCurrency"] as const) {
      filters.push(`${column} IS ?`); parameters.push(input.route[column]);
    }
    const primaryEntry = (direction: "debit" | "credit", field: "account_id" | "currency") => `(SELECT e.${field} FROM movement_legs l JOIN ledger_entries e ON e.id = l.ledger_entry_id WHERE l.movement_group_id = movement.id AND e.direction = '${direction}' ${direction === "debit" ? "AND l.leg_kind <> 'explicit_fee'" : ""} ORDER BY l.position, l.rowid LIMIT 1)`;
    const query = `SELECT * FROM (
      SELECT
        movement.id, movement.status, movement.evidence_kind AS evidenceKind,
        MIN(entry.occurred_at) AS occurredAt,
        CAST(conversion.sold_amount_minor AS TEXT) AS soldAmountMinor,
        conversion.sold_currency AS soldCurrency,
        ${primaryEntry("debit", "account_id")} AS sourceAccountId,
        ${primaryEntry("credit", "account_id")} AS destinationAccountId,
        COALESCE(${primaryEntry("debit", "currency")}, conversion.sold_currency) AS sourceCurrency,
        ${primaryEntry("credit", "currency")} AS destinationCurrency,
        ${reportCurrency ? "CAST(source_valuation.converted_amount_minor AS TEXT)" : "CAST(conversion.sold_amount_minor AS TEXT)"} AS selectedSoldReportAmountMinor
      FROM movement_groups movement
      JOIN movement_legs leg ON leg.movement_group_id = movement.id
      JOIN ledger_entries entry ON entry.id = leg.ledger_entry_id
      LEFT JOIN fx_conversions conversion ON conversion.movement_group_id = movement.id
      ${reportCurrency ? "LEFT JOIN fx_conversion_source_valuations source_valuation ON source_valuation.fx_conversion_id = conversion.id AND source_valuation.target_currency = ?" : ""}
      WHERE movement.status IN ('confirmed', 'reconciled')
        ${costMethod ? "AND EXISTS (SELECT 1 FROM cost_components selected_cost WHERE selected_cost.movement_group_id = movement.id AND selected_cost.method = ?)" : ""}
      GROUP BY movement.id
      ${context.startAt ? `HAVING MIN(entry.occurred_at) >= substr(?, 1, 19)${context.endAt ? " AND MIN(entry.occurred_at) < substr(?, 1, 19)" : ""}` : ""}
    ) ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}`;
    const total = (await this.#database.get<{ count: number }>(`SELECT count(*) AS count FROM (${query})`, parameters))?.count ?? 0;
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(Math.max(input.page ?? 1, 1), pageCount);
    const groups = await this.#database.all<{
      id: string;
      status: "confirmed" | "reconciled";
      evidenceKind: string;
      occurredAt: string;
      soldAmountMinor: string | null;
      soldCurrency: string | null;
      selectedSoldReportAmountMinor: string | null;
    }>(`${query} ORDER BY occurredAt DESC, id LIMIT ? OFFSET ?`, [...parameters, pageSize, (page - 1) * pageSize]);
    const chains: MovementChainView[] = [];
    for (const group of groups) {
      const [rawLegs, rawCosts] = await Promise.all([
        this.#database.all<Omit<MovementLegView, "reportAmountMinor" | "reportCurrency" | "valuationMissing"> & { selectedReportAmountMinor: string | null }>(`
          SELECT
            leg.id,
            entry.id AS entryId,
            entry.account_id AS accountId,
            account.display_name AS accountName,
            account.owner_scope AS ownerScope,
            CAST(entry.amount_minor AS TEXT) AS amountMinor,
            entry.currency,
            entry.direction,
            entry.occurred_at AS occurredAt,
            leg.leg_kind AS legKind,
            leg.position,
            ${reportCurrency ? "CAST(valuation.converted_amount_minor AS TEXT)" : "CAST(entry.amount_minor AS TEXT)"} AS selectedReportAmountMinor
          FROM movement_legs leg
          JOIN ledger_entries entry ON entry.id = leg.ledger_entry_id
          JOIN accounts account ON account.id = entry.account_id
          ${reportCurrency ? "LEFT JOIN ledger_entry_valuations valuation ON valuation.ledger_entry_id = entry.id AND valuation.target_currency = ?" : ""}
          WHERE leg.movement_group_id = ?
          ORDER BY leg.position, leg.rowid
        `, reportCurrency ? [reportCurrency, group.id] : [group.id]),
        this.#database.all<Omit<CostView, "groupStatus" | "estimated" | "reportAmountMinor" | "reportCurrency" | "valuationMissing"> & { estimated: number; selectedReportAmountMinor: string | null }>(`
          SELECT
            component.id,
            component.movement_group_id AS movementGroupId,
            component.method,
            CAST(component.amount_minor AS TEXT) AS amountMinor,
            component.currency,
            component.estimated,
            conversion.benchmark_source AS benchmarkSource,
            conversion.benchmark_publication_date AS publicationDate,
            ${reportCurrency ? "CAST(valuation.converted_amount_minor AS TEXT)" : "CAST(component.amount_minor AS TEXT)"} AS selectedReportAmountMinor
          FROM cost_components component
          LEFT JOIN fx_conversions conversion ON conversion.movement_group_id = component.movement_group_id
          ${reportCurrency ? "LEFT JOIN cost_component_valuations valuation ON valuation.cost_component_id = component.id AND valuation.target_currency = ?" : ""}
          WHERE component.movement_group_id = ?
          ORDER BY component.rowid
        `, reportCurrency ? [reportCurrency, group.id] : [group.id]),
      ]);
      const legs: MovementLegView[] = rawLegs.map(({ selectedReportAmountMinor, ...leg }) => ({
        ...leg,
        reportAmountMinor: selectedReportAmountMinor,
        reportCurrency: reportCurrency ?? leg.currency,
        valuationMissing: selectedReportAmountMinor === null,
      }));
      const debit = legs.find((leg) => leg.direction === "debit" && leg.legKind !== "explicit_fee");
      const credit = legs.find((leg) => leg.direction === "credit");
      const source = debit
        ? {
          accountName: debit.accountName,
          ownerScope: debit.ownerScope,
          amountMinor: (BigInt(debit.amountMinor) < 0n ? -BigInt(debit.amountMinor) : BigInt(debit.amountMinor)).toString(),
          currency: debit.currency,
          reportAmountMinor: debit.reportAmountMinor === null
            ? null
            : (BigInt(debit.reportAmountMinor) < 0n ? -BigInt(debit.reportAmountMinor) : BigInt(debit.reportAmountMinor)).toString(),
          reportCurrency: debit.reportCurrency,
        }
        : group.soldAmountMinor && group.soldCurrency
          ? {
            accountName: `ФОП ${group.soldCurrency} · валютний пул`,
            ownerScope: "SOLE_PROPRIETOR" as const,
            amountMinor: group.soldAmountMinor,
            currency: group.soldCurrency,
            reportAmountMinor: group.selectedSoldReportAmountMinor,
            reportCurrency: reportCurrency ?? group.soldCurrency,
          }
          : null;
      const destination = credit
        ? {
          accountName: credit.accountName,
          ownerScope: credit.ownerScope,
          amountMinor: (BigInt(credit.amountMinor) < 0n ? -BigInt(credit.amountMinor) : BigInt(credit.amountMinor)).toString(),
          currency: credit.currency,
          reportAmountMinor: credit.reportAmountMinor === null
            ? null
            : (BigInt(credit.reportAmountMinor) < 0n ? -BigInt(credit.reportAmountMinor) : BigInt(credit.reportAmountMinor)).toString(),
          reportCurrency: credit.reportCurrency,
        }
        : null;
      chains.push({
        id: group.id,
        status: group.status,
        evidenceKind: group.evidenceKind,
        occurredAt: group.occurredAt,
        source,
        destination,
        legs,
        costs: rawCosts.map(({ selectedReportAmountMinor, ...cost }) => ({
          ...cost,
          groupStatus: group.status,
          estimated: cost.estimated === 1,
          reportAmountMinor: selectedReportAmountMinor,
          reportCurrency: reportCurrency ?? cost.currency,
          valuationMissing: selectedReportAmountMinor === null,
        })),
      });
    }
    return { items: chains, total, page, pageSize, pageCount };
  }

  async movementGroups(): Promise<MovementGroupView[]> {
    const groups = await this.#database.all<Omit<MovementGroupView, "legs" | "costCount"> & { costCount: number }>(`
      SELECT
        mg.id,
        mg.status,
        mg.evidence_kind AS evidenceKind,
        mg.confirmed_at AS confirmedAt,
        (SELECT count(*) FROM cost_components cc WHERE cc.movement_group_id = mg.id) AS costCount
      FROM movement_groups mg
      WHERE mg.status IN ('confirmed', 'reconciled')
      ORDER BY COALESCE(mg.confirmed_at, mg.created_at) DESC, mg.id
      LIMIT 200
    `);
    const output: MovementGroupView[] = [];
    for (const group of groups) {
      const legs = await this.#database.all<MovementLegView>(`
        SELECT
          ml.id,
          le.id AS entryId,
          a.display_name AS accountName,
          a.owner_scope AS ownerScope,
          CAST(le.amount_minor AS TEXT) AS amountMinor,
          le.currency,
          le.direction,
          le.occurred_at AS occurredAt,
          ml.leg_kind AS legKind,
          ml.position
        FROM movement_legs ml
        JOIN ledger_entries le ON le.id = ml.ledger_entry_id
        JOIN accounts a ON a.id = le.account_id
        WHERE ml.movement_group_id = ?
        ORDER BY ml.position, ml.id
      `, [group.id]);
      output.push({ ...group, legs });
    }
    return output;
  }

  async unlinkedTransactionCount(): Promise<number> {
    const row = await this.#database.get<{ count: number }>(
      "SELECT count(*) AS count FROM ledger_entries WHERE reconciliation_status = 'unlinked' AND entry_kind = 'unclassified'",
    );
    return row?.count ?? 0;
  }

  async costs(): Promise<CostView[]> {
    const rows = await this.#database.all<Omit<CostView, "estimated"> & { estimated: number }>(`
      SELECT
        cc.id,
        cc.movement_group_id AS movementGroupId,
        mg.status AS groupStatus,
        cc.method,
        CAST(cc.amount_minor AS TEXT) AS amountMinor,
        cc.currency,
        cc.estimated,
        fx.benchmark_source AS benchmarkSource,
        fx.benchmark_publication_date AS publicationDate
      FROM cost_components cc
      JOIN movement_groups mg ON mg.id = cc.movement_group_id
      LEFT JOIN fx_conversions fx ON fx.movement_group_id = cc.movement_group_id
      ORDER BY cc.rowid DESC
      LIMIT 500
    `);
    return rows.map((row) => ({ ...row, estimated: row.estimated === 1 }));
  }

  async feeAttachmentCandidates(): Promise<FeeAttachmentCandidateView[]> {
    return this.#database.all<FeeAttachmentCandidateView>(`
      SELECT
        le.id,
        a.display_name AS accountName,
        CAST(le.amount_minor AS TEXT) AS amountMinor,
        le.currency,
        le.occurred_at AS occurredAt
      FROM ledger_entries le
      JOIN accounts a ON a.id = le.account_id
      WHERE le.entry_kind = 'explicit_fee'
        AND le.direction = 'debit'
        AND le.reconciliation_status = 'unlinked'
        AND NOT EXISTS (SELECT 1 FROM movement_legs ml WHERE ml.ledger_entry_id = le.id)
        AND NOT EXISTS (
          SELECT 1 FROM movement_candidates mc
          WHERE mc.status IN ('pending', 'confirmed')
            AND (mc.debit_entry_id = le.id OR mc.credit_entry_id = le.id)
        )
      ORDER BY le.occurred_at DESC, le.id
      LIMIT 200
    `);
  }

  async imports(): Promise<ImportBatchView[]> {
    const rows = await this.#database.all<Omit<ImportBatchView, "issueCodes"> & { issueCodesJson: string }>(`
      SELECT
        ib.id,
        ib.status,
        ia.parser_kind AS parserKind,
        ia.parser_version AS parserVersion,
        ia.imported_at AS importedAt,
        ib.committed_at AS committedAt,
        ib.row_count AS rowCount,
        ib.posted_count AS postedCount,
        ib.non_posted_count AS nonPostedCount,
        ib.unresolved_count AS unresolvedCount,
        ib.rejected_count AS rejectedCount,
        ib.reconciliation_issues_json AS issueCodesJson
      FROM import_batches ib
      JOIN import_artifacts ia ON ia.id = ib.artifact_id
      ORDER BY ia.imported_at DESC, ib.id
      LIMIT 200
    `);
    return rows.map(({ issueCodesJson, ...row }) => ({ ...row, issueCodes: JSON.parse(issueCodesJson) as string[] }));
  }

  async importBatch(batchId: string): Promise<ImportBatchView | null> {
    const row = await this.#database.get<Omit<ImportBatchView, "issueCodes"> & { issueCodesJson: string }>(`
      SELECT
        ib.id,
        ib.status,
        ia.parser_kind AS parserKind,
        ia.parser_version AS parserVersion,
        ia.imported_at AS importedAt,
        ib.committed_at AS committedAt,
        ib.row_count AS rowCount,
        ib.posted_count AS postedCount,
        ib.non_posted_count AS nonPostedCount,
        ib.unresolved_count AS unresolvedCount,
        ib.rejected_count AS rejectedCount,
        ib.reconciliation_issues_json AS issueCodesJson
      FROM import_batches ib
      JOIN import_artifacts ia ON ia.id = ib.artifact_id
      WHERE ib.id = ?
    `, [batchId]);
    if (!row) return null;
    const { issueCodesJson, ...batch } = row;
    return { ...batch, issueCodes: JSON.parse(issueCodesJson) as string[] };
  }

  async categories(scope?: "business" | "personal"): Promise<Array<{ code: string; displayName: string; scope: string }>> {
    if (scope) {
      return this.#database.all(
        "SELECT code, display_name AS displayName, scope FROM categories WHERE scope = ? ORDER BY display_name",
        [scope],
      );
    }
    return this.#database.all("SELECT code, display_name AS displayName, scope FROM categories ORDER BY scope, display_name");
  }

  async movementForCost(groupId: string): Promise<{
    groupId: string;
    currencies: string[];
    occurredOn: string;
    soldCurrency: string | null;
    receivedCurrency: string | null;
  } | null> {
    const rows = await this.#database.all<{ currency: string; occurredAt: string; direction: "debit" | "credit" }>(`
      SELECT le.currency, le.occurred_at AS occurredAt, le.direction
      FROM movement_legs ml
      JOIN ledger_entries le ON le.id = ml.ledger_entry_id
      WHERE ml.movement_group_id = ?
      ORDER BY ml.position
    `, [groupId]);
    if (rows.length === 0) return null;
    return {
      groupId,
      currencies: [...new Set(rows.map(({ currency }) => currency))],
      occurredOn: rows.map(({ occurredAt }) => occurredAt.slice(0, 10)).sort()[0]!,
      soldCurrency: rows.find(({ direction }) => direction === "debit")?.currency ?? null,
      receivedCurrency: rows.find(({ direction }) => direction === "credit")?.currency ?? null,
    };
  }

  async #periodContext(period: ReportPeriod): Promise<{ anchorAt: string | null; startAt: string | null; endAt: string | null }> {
    if (parseReportMonth(period)) {
      const range = reportMonthRange(period);
      return { ...range, anchorAt: new Date(new Date(range.endAt).valueOf() - 1).toISOString() };
    }
    const anchor = await this.#database.get<{ anchorAt: string | null }>("SELECT MAX(occurred_at) AS anchorAt FROM ledger_entries");
    const latestDataAt = anchor?.anchorAt ?? null;
    if (!latestDataAt) return { anchorAt: null, startAt: null, endAt: null };
    const now = this.#now();
    if (!Number.isFinite(now.valueOf())) throw new Error("REPORT_DATE_INVALID");
    const anchorAt = Date.parse(latestDataAt) > now.valueOf() ? latestDataAt : now.toISOString();
    return { anchorAt, startAt: anchorAt ? reportPeriodStart(anchorAt, period) : null, endAt: null };
  }
}

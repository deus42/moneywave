import { addWaveCosts, addWaveMoney, emptyWaveMoney, unknownWaveMoney, type MoneyWavesView, type WaveCost, type WaveCostMethod, type WaveLink, type WaveMoney, type WaveNode } from "@/domain/money-waves";
import { reportPeriodStart, type ReportCurrency, type ReportPeriod } from "@/domain/reporting";
import type { EncryptedDatabase } from "@/server/db/database";
import { FinanceCenters } from "./finance-centers";

interface Entry {
  id: string; accountId: string; amount: string; currency: string; report: string | null;
  date: string | null; kind: string; category: string | null;
  groupId: string | null; evidence: string | null; legKind: string | null;
}
interface CostRow { groupId: string; method: WaveCostMethod; amount: string; currency: string; report: string | null }
interface FxRow { groupId: string; amount: string; currency: string; report: string | null }
const movementKinds = new Set(["owner_draw", "transfer_in", "transfer_out", "fx_sell", "fx_buy"]);

function value(row: { amount: string; currency: string; report: string | null }, target: ReportCurrency, sign = 1n): WaveMoney {
  const report = row.currency === target ? row.amount : row.report;
  return { native: [{ currency: row.currency, minor: (sign * BigInt(row.amount)).toString() }], reportMinor: report === null ? null : (sign * BigInt(report)).toString(), missing: report === null ? 1 : 0, count: 1 };
}
function emptyNode(id: string, label: string, currency: string, stage: number, kind: WaveNode["kind"], provider = ""): WaveNode {
  return { id, label, currency, stage, kind, provider, balance: null, income: emptyWaveMoney(), spending: emptyWaveMoney(), taxes: emptyWaveMoney(), business: emptyWaveMoney(), costs: [], cash: null };
}

/** No imports, rate lookups, reconciliation, mutations or raw financial descriptions. */
export class MoneyWavesReader {
  constructor(private readonly database: EncryptedDatabase, private readonly now = () => new Date()) {}

  async read(period: ReportPeriod, currency: ReportCurrency): Promise<MoneyWavesView> {
    const asOf = this.now().toISOString().slice(0, 10);
    const startAt = reportPeriodStart(asOf, period)?.slice(0, 10) ?? null;
    const inPeriod = (date: string | null) => date !== null && date.slice(0, 10) <= asOf && (!startAt || date.slice(0, 10) >= startAt);
    const [capital, providers, entries, costs, conversions] = await Promise.all([
      new FinanceCenters(this.database, this.now).capital(asOf, currency),
      this.database.all<{ id: string; code: string }>("SELECT a.id, p.code FROM accounts a JOIN providers p ON p.id = a.provider_id"),
      this.database.all<Entry>(`
        WITH latest_category AS (
          SELECT ledger_entry_id, category_id, ROW_NUMBER() OVER (PARTITION BY ledger_entry_id ORDER BY assigned_at DESC, rowid DESC) AS rank
          FROM category_assignments
        ), accepted_leg AS (
          SELECT l.ledger_entry_id, l.movement_group_id, l.leg_kind, g.evidence_kind
          FROM movement_legs l JOIN movement_groups g ON g.id = l.movement_group_id
          WHERE g.status IN ('confirmed', 'reconciled')
        )
        SELECT e.id, e.account_id AS accountId, CAST(e.amount_minor AS TEXT) AS amount, e.currency,
          CAST(v.converted_amount_minor AS TEXT) AS report, e.occurred_at AS date, e.entry_kind AS kind,
          c.category_id AS category, l.movement_group_id AS groupId, l.evidence_kind AS evidence, l.leg_kind AS legKind
        FROM ledger_entries e LEFT JOIN ledger_entry_valuations v ON v.ledger_entry_id = e.id AND v.target_currency = ?
        LEFT JOIN latest_category c ON c.ledger_entry_id = e.id AND c.rank = 1
        LEFT JOIN accepted_leg l ON l.ledger_entry_id = e.id ORDER BY e.id
      `, [currency]),
      this.database.all<CostRow>(`SELECT c.movement_group_id AS groupId, c.method, CAST(c.amount_minor AS TEXT) AS amount, c.currency,
        CAST(v.converted_amount_minor AS TEXT) AS report FROM cost_components c
        JOIN movement_groups g ON g.id = c.movement_group_id AND g.status IN ('confirmed','reconciled')
        LEFT JOIN cost_component_valuations v ON v.cost_component_id = c.id AND v.target_currency = ? ORDER BY c.id`, [currency]),
      this.database.all<FxRow>(`SELECT f.movement_group_id AS groupId, CAST(f.sold_amount_minor AS TEXT) AS amount, f.sold_currency AS currency,
        CAST(v.converted_amount_minor AS TEXT) AS report FROM fx_conversions f
        JOIN movement_groups g ON g.id = f.movement_group_id AND g.status IN ('confirmed','reconciled') AND g.evidence_kind = 'provider_fx_description'
        LEFT JOIN fx_conversion_source_valuations v ON v.fx_conversion_id = f.id AND v.target_currency = ? ORDER BY f.id`, [currency]),
    ]);
    const providerByAccount = new Map(providers.map(p => [p.id, p.code]));
    const nodes = new Map<string, WaveNode>();
    for (const p of capital.positions) {
      const code = providerByAccount.get(p.id) ?? "";
      // Columns are presentation, not assertions about the provenance of pooled funds.
      const stage = p.type === "cash" ? 4 : p.scope === "SOLE_PROPRIETOR" ? 0 : /privat|mono/u.test(code) ? (p.currency === "UAH" ? 1 : 2) : 3;
      const node = emptyNode(p.id, p.name, p.currency, stage, p.accountId ? "account" : "manual", p.provider);
      node.balance = { nativeMinor: p.nativeMinor, reportMinor: p.reportMinor, observedAt: p.observedAt, precision: p.precision, source: p.source, status: p.status, carriedForward: p.carriedForward,
        cashGapMinor: p.manualEvidence?.comparison === "cash_record_gap" ? p.manualEvidence.differenceMinor : null, rateDate: p.publicationDate, rateStale: p.rateStale };
      if (p.type === "cash") node.cash = { inflow: emptyWaveMoney(), outflow: emptyWaveMoney() };
      nodes.set(node.id, node);
    }
    const summary: MoneyWavesView["summary"] = { knownNetMinor: capital.knownNetMinor, missingBalances: capital.unvaluedCount, carriedBalances: capital.carriedForwardCount,
      income: emptyWaveMoney(), spending: emptyWaveMoney(), taxes: emptyWaveMoney(), business: emptyWaveMoney(), costs: [], incomplete: 0,
      undated: entries.filter(e => !e.date).length, unclassified: 0, uncategorized: 0, fxWithoutEstimate: 0 };
    const linkMap = new Map<string, WaveLink>();
    function link(from: string, to: string, kind: WaveLink["kind"], sent: WaveMoney, received: WaveMoney, groupCosts: WaveCost[] = []) {
      const key = JSON.stringify([from, to, kind]);
      const current = linkMap.get(key);
      if (current) { current.sent = addWaveMoney(current.sent, sent); current.received = addWaveMoney(current.received, received); current.count++; current.costs = addWaveCosts(current.costs, groupCosts); }
      else linkMap.set(key, { id: `wave:${encodeURIComponent(key)}`, from, to, kind, sent, received, count: 1, costs: groupCosts });
    }
    function boundary(accountId: string, incoming: boolean): string {
      const id = `boundary:${accountId}:${incoming ? "in" : "out"}`;
      const owner = nodes.get(accountId)!;
      if (!nodes.has(id)) nodes.set(id, emptyNode(id, incoming ? "Звідки — не підтверджено" : "Куди далі — не підтверджено", owner.currency, owner.stage, "boundary"));
      return id;
    }
    const groups = new Map<string, Entry[]>();
    for (const row of entries) if (row.groupId) { const rows = groups.get(row.groupId) ?? []; rows.push(row); groups.set(row.groupId, rows); }
    const costByGroup = new Map<string, WaveCost[]>();
    for (const row of costs) costByGroup.set(row.groupId, addWaveCosts(costByGroup.get(row.groupId) ?? [], [{ method: row.method, amount: value(row, currency) }]));
    for (const [groupId, allRows] of groups) {
      const dated = allRows.filter(e => e.date && e.date.slice(0, 10) <= asOf);
      const movementRows = dated.filter(e => e.legKind !== "explicit_fee");
      const anchor = movementRows.map(e => e.date!).sort()[0];
      if (!anchor || !inPeriod(anchor)) continue;
      let groupCosts = costByGroup.get(groupId) ?? [];
      // Explicit fee components already include their fee-entry evidence.
      if (!groupCosts.some(c => c.method === "explicit_statement_fee")) {
        for (const e of dated.filter(e => e.legKind === "explicit_fee")) groupCosts = addWaveCosts(groupCosts, [{ method: "explicit_statement_fee", amount: value(e, currency, -1n) }]);
      }
      summary.costs = addWaveCosts(summary.costs, groupCosts);
      const bySide = (sign: "debit" | "credit") => {
        const map = new Map<string, WaveMoney>();
        for (const row of movementRows.filter(e => sign === "debit" ? BigInt(e.amount) < 0n : BigInt(e.amount) > 0n)) map.set(row.accountId, addWaveMoney(map.get(row.accountId) ?? emptyWaveMoney(), value(row, currency, sign === "debit" ? -1n : 1n)));
        return map;
      };
      const debit = bySide("debit"), credit = bySide("credit");
      const groupIsFx = movementRows.some(e => e.kind === "fx_buy" || e.kind === "fx_sell" || e.evidence === "provider_fx_description") || new Set(movementRows.map(e => e.currency)).size > 1;
      if (groupIsFx && !groupCosts.some(c => c.method === "fx_spread_estimate")) summary.fxWithoutEstimate++;
      if (!debit.size && movementRows[0]?.evidence === "provider_fx_description") {
        for (const fx of conversions.filter(f => f.groupId === groupId)) {
          const target = nodes.get(movementRows[0]!.accountId)!;
          const pool = `pool:${providerByAccount.get(target.id)}:${fx.currency}`;
          if (!nodes.has(pool)) nodes.set(pool, emptyNode(pool, `Продаж ${fx.currency} · рахунок невідомий`, fx.currency, 0, "source_pool", target.provider));
          debit.set(pool, addWaveMoney(debit.get(pool) ?? emptyWaveMoney(), value(fx, currency)));
        }
      }
      if (debit.size === 1 && credit.size === 1) {
        const [from, sent] = [...debit][0]!, [to, received] = [...credit][0]!;
        const kind = nodes.get(from)?.currency !== nodes.get(to)?.currency ? "fx" : "transfer";
        link(from, to, kind, sent, received, groupCosts);
      } else if (debit.size > 1 || credit.size > 1) {
        const junctionId = `junction:${groupId}`;
        const junction = emptyNode(junctionId, "Спільний переказ", "", 2, "junction"); junction.costs = groupCosts; nodes.set(junctionId, junction);
        for (const [id, amount] of debit) link(id, junctionId, "junction", amount, amount);
        for (const [id, amount] of credit) link(junctionId, id, "junction", amount, amount);
        if (!debit.size || !credit.size) {
          const endpoint = boundary(movementRows[0]!.accountId, !debit.size);
          link(!debit.size ? endpoint : junctionId, !debit.size ? junctionId : endpoint, "incomplete", unknownWaveMoney(), unknownWaveMoney());
          summary.incomplete++;
        }
      } else {
        for (const [id, amount] of debit) { link(id, boundary(id, false), "incomplete", amount, unknownWaveMoney(), groupCosts); summary.incomplete++; }
        for (const [id, amount] of credit) { link(boundary(id, true), id, "incomplete", unknownWaveMoney(), amount, groupCosts); summary.incomplete++; }
      }
    }
    for (const row of entries.filter(e => inPeriod(e.date))) {
      const node = nodes.get(row.accountId)!;
      const type = row.kind === "business_income" ? "income" : row.kind === "terminal_personal_expense" ? "spending" : ["tax", "mandatory_payment"].includes(row.kind) ? "taxes" : row.kind === "business_expense" ? "business" : null;
      if (type) {
        const amount = value(row, currency, type === "income" ? 1n : -1n);
        node[type] = addWaveMoney(node[type], amount); summary[type] = addWaveMoney(summary[type], amount);
        if (type === "spending" && !row.category) summary.uncategorized++;
      }
      if (node.cash) {
        const incoming = BigInt(row.amount) >= 0n;
        const key = incoming ? "inflow" : "outflow";
        node.cash[key] = addWaveMoney(node.cash[key], value(row, currency, incoming ? 1n : -1n));
      }
      if (row.kind === "unclassified") summary.unclassified++;
      if (!row.groupId && row.kind === "explicit_fee") {
        const fee: WaveCost[] = [{ method: "explicit_statement_fee", amount: value(row, currency, -1n) }];
        node.costs = addWaveCosts(node.costs, fee); summary.costs = addWaveCosts(summary.costs, fee);
      }
      if (!row.groupId && movementKinds.has(row.kind)) {
        const incoming = BigInt(row.amount) >= 0n;
        const amount = value(row, currency, incoming ? 1n : -1n);
        const endpoint = boundary(row.accountId, incoming);
        link(incoming ? endpoint : row.accountId, incoming ? row.accountId : endpoint, "incomplete", incoming ? unknownWaveMoney() : amount, incoming ? amount : unknownWaveMoney());
        summary.incomplete++;
      }
    }
    return { period, currency, asOf, startAt, nodes: [...nodes.values()].sort((a, b) => a.stage - b.stage || a.provider.localeCompare(b.provider) || a.currency.localeCompare(b.currency) || a.id.localeCompare(b.id)), links: [...linkMap.values()], summary };
  }
}

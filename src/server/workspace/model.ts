import { z } from 'zod';

const cents = z.number().int().min(-1e12).max(1e12);
const positiveCents = cents.nonnegative();
const day = z.iso.date();
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u);
const text = z.string().trim().min(1).max(240);
const id = z.string().min(1).max(180);
export const rowSchema = z.object({
  id, date: day, eur: cents, group: text, description: z.string().max(4000), provider: z.string().max(120),
  source: z.string().max(100), sourceRefs: z.array(z.record(z.string(), z.unknown())).default([]),
  nativeEur: cents.nullish(), nativeMinor: z.string().nullish(), currency: z.string().nullish(),
  originalCategory: z.string().nullish(), homeGroup: z.string().nullish(), trip: z.string().nullish(),
  aiProvider: z.string().optional(), creditId: id.optional(), purchaseId: id.optional(),
  adjustmentKind: z.string().optional(), excluded: z.boolean().default(false), unresolved: z.boolean().default(false),
  categoryPolicy: z.object({version:z.string(),rule:z.string()}).optional(),
});
export type ReportRow = z.infer<typeof rowSchema>;
export const collectionSchema = z.object({
  id, kind: z.enum(['trip', 'event', 'purchase']), name: text, start: day, end: day,
  budget: positiveCents.nullable(), note: z.string().max(2000).default(''),
  rowIds: z.array(id).max(2000), season: z.boolean().default(false),
  dateLabel: z.string().max(200).optional(),
  referenceAmount: positiveCents.nullable().default(null),
  manualPayment: z.object({ date: day, eur: positiveCents.positive() }).nullable().default(null),
}).refine(v => v.end >= v.start, 'END_BEFORE_START');
export type Collection = z.infer<typeof collectionSchema>;
export const reportSchema = z.object({
  version: z.literal(1), coverage: z.object({ start: day, end: day, generatedAt: z.string() }),
  rows: z.array(rowSchema), months: z.array(z.object({ month, income: cents, tax: cents, bank: cents, netSpending: cents,
    grossSpending: cents, partial: z.boolean(), unknown: cents.default(0), fx: cents.nullable().default(null), manualOnly: z.boolean().default(false) })),
  plan: z.record(text, positiveCents), collections: z.array(collectionSchema),
  sources: z.array(z.object({ name: text, sha256: z.string().regex(/^[a-f0-9]{64}$/u) })),
  costRows: z.array(z.object({ date: day, eur: cents, kind: z.enum(['tax','bank','fx']), label: text, sourceId: z.string().optional() })).default([]),
  ledgerDigest: z.string(),
});
export type WorkspaceReport = z.infer<typeof reportSchema>;
export const stateSchema = z.object({
  budgets: z.array(z.object({ from: month, category: text, amount: positiveCents })),
  overrides: z.record(id, z.object({ category: text, name: z.string().trim().max(4000).optional(), note: z.string().max(2000), excluded: z.boolean() })),
  categoryNames: z.record(text, text).default({}),
  collections: z.array(collectionSchema),
});
export type WorkspaceState = z.infer<typeof stateSchema>;
export const mutationSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('budget'), revision: z.number().int().nonnegative(), from: month, category: text, amount: positiveCents }),
  z.object({ action: z.literal('row'), revision: z.number().int().nonnegative(), id, category: text, name: z.string().trim().max(4000).optional(), note: z.string().max(2000), excluded: z.boolean() }),
  z.object({ action: z.literal('categoryName'), revision: z.number().int().nonnegative(), category: text, name: text }),
  z.object({ action: z.literal('collection'), revision: z.number().int().nonnegative(), collection: collectionSchema }),
  z.object({ action: z.literal('deleteCollection'), revision: z.number().int().nonnegative(), id }),
  z.object({ action: z.literal('undo'), revision: z.number().int().positive() }),
]);
export type Mutation = z.infer<typeof mutationSchema>;

export function exactSum(values: number[]): number {
  const total = values.reduce((a, b) => a + BigInt(b), 0n);
  if (total > BigInt(Number.MAX_SAFE_INTEGER) || total < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error('AMOUNT_OVERFLOW');
  return Number(total);
}
export function initialState(report: WorkspaceReport): WorkspaceState {
  return { budgets: [], overrides: {}, categoryNames: {}, collections: structuredClone(report.collections) };
}
export function effectiveRows(report: WorkspaceReport, state: WorkspaceState): ReportRow[] {
  const trips = new Map<string, string>();
  for (const c of state.collections.filter(c => c.kind === 'trip')) for (const id of c.rowIds) trips.set(id, c.name);
  const rows = report.rows.map(row => {
    const edit = Object.hasOwn(state.overrides, row.id) ? state.overrides[row.id] : undefined;
    const trip = trips.get(row.id);
    return { ...row, group: trip ? 'Відпустки та подорожі' : (edit?.category ?? row.homeGroup ?? row.group),
      description: edit?.name !== undefined ? edit.name || row.description : edit?.note || row.description, excluded: edit?.excluded ?? row.excluded, trip: trip ?? null };
  });
  for (const c of state.collections) if (c.manualPayment) rows.push({ id: `user:${c.id}`, date: c.manualPayment.date,
    eur: c.manualPayment.eur, group: c.kind === 'purchase' ? 'Покупки, техніка, одяг, подарунки, дім' : 'Відпустки та подорожі',
    description: c.name, provider: 'Ручна оплата', source: 'user', sourceRefs: [], trip: c.kind === 'trip' ? c.name : null,
    excluded: false, unresolved: false });
  return rows;
}
export function budgetFor(report: WorkspaceReport, state: WorkspaceState, category: string, month: string): number {
  const versions = state.budgets.filter(b => b.category === category && b.from <= month).sort((a,b) => b.from.localeCompare(a.from));
  return versions[0]?.amount ?? (Object.hasOwn(report.plan, category) ? report.plan[category] : 0);
}
/** Manual payments extend reporting dates without inventing income or statement coverage. */
export function reportingCoverage(report: WorkspaceReport, state: WorkspaceState): WorkspaceReport {
  const result = structuredClone(report);
  for (const c of state.collections) if (c.manualPayment) {
    const month = c.manualPayment.date.slice(0,7);
    if (!result.months.some(m=>m.month===month)) result.months.push({month,income:0,tax:0,bank:0,netSpending:0,grossSpending:0,partial:true,unknown:0,fx:null,manualOnly:true});
    if (c.manualPayment.date > result.coverage.end) result.coverage.end=c.manualPayment.date;
    if (c.manualPayment.date < result.coverage.start) result.coverage.start=c.manualPayment.date;
  }
  result.months.sort((a,b)=>a.month.localeCompare(b.month));
  return result;
}
export function comparisonFor(report: WorkspaceReport, state: WorkspaceState, period: string, end: string) {
  const start = [period.length === 4 ? period + '-01-01' : period + '-01', report.coverage.start].sort().at(-1)!;
  const shift = (day: string) => {
    const d = new Date(day + 'T00:00:00Z');
    const year = d.getUTCFullYear() - (period.length === 4 ? 1 : 0);
    const month = d.getUTCMonth() - (period.length === 4 ? 0 : 1);
    const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    if (period.length === 7 && day === end && d.getUTCDate() === new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate()) {
      return new Date(Date.UTC(year,month,last)).toISOString().slice(0,10);
    }
    return new Date(Date.UTC(year, month, Math.min(d.getUTCDate(), last))).toISOString().slice(0,10);
  };
  const from = shift(start), to = shift(end);
  if (from < report.coverage.start || to > report.coverage.end) return null;
  const rows = effectiveRows(report,state).filter(r => !r.excluded && r.date >= from && r.date <= to);
  return { period: `${from}–${to}`,
    from, to, categories: [...new Set(rows.map(r=>r.group))].map(category=>({ category,
      actual: exactSum(rows.filter(r=>r.group===category).map(r=>r.eur)) })) };
}
export function summary(report: WorkspaceReport, state: WorkspaceState, period: string) {
  report = reportingCoverage(report,state);
  if (!/^\d{4}(?:-(?:0[1-9]|1[0-2]))?$/u.test(period)) throw new Error('PERIOD_INVALID');
  const months = report.months.filter(m => m.month.startsWith(period));
  if (!months.length) throw new Error('PERIOD_UNAVAILABLE');
  const rows = effectiveRows(report, state).filter(r => r.date.startsWith(period) && !r.excluded);
  const original = report.rows.filter(r => r.date.startsWith(period) && !r.excluded);
  const refunds = exactSum(months.map(m => m.grossSpending - m.netSpending));
  const net = exactSum(rows.map(r => r.eur)) - refunds;
  const categories = [...new Set([...Object.keys(report.plan), ...state.budgets.map(b => b.category), ...rows.map(r => r.group)])]
    .map(category => ({ category, actual: exactSum(rows.filter(r => r.group === category).map(r => r.eur)),
      plan: exactSum(months.map(m => budgetFor(report, state, category, m.month))) }));
  const income = exactSum(months.map(m => m.income)), tax = exactSum(months.map(m => m.tax)), bank = exactSum(months.map(m => m.bank));
  const fx = months.every(m => m.fx !== null) ? exactSum(months.map(m => m.fx!)) : null;
  return { period, months, rows, categories, income, tax, bank, fx, net, refunds,
    manualOnly: months.every(m=>m.manualOnly),
    costRows: report.costRows.filter(r => r.date.startsWith(period)),
    plan: exactSum(categories.map(c => c.plan)), remainder: income - net - tax - bank,
    unknown: exactSum(months.map(m => m.unknown)) - exactSum(rows.filter(r => r.unresolved).map(r => r.eur)),
    correctionDelta: exactSum(rows.map(r => r.eur)) - exactSum(original.map(r => r.eur)),
    partial: months.some(m => m.partial) || (period.length === 4 && months.length !== 12),
  };
}
export function collectionTotals(c: Collection, rows: ReportRow[]) {
  const linked = rows.filter(r => (c.rowIds.includes(r.id) || r.id === `user:${c.id}`) && !r.excluded);
  return { paid: exactSum(linked.filter(r => r.eur > 0).map(r => r.eur)),
    recovered: -exactSum(linked.filter(r => r.eur < 0).map(r => r.eur)),
    net: exactSum(linked.map(r => r.eur)), count: linked.length };
}

export const annualComparisonSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('calendar'), year: z.number().int().min(1901).max(9998) }),
  z.object({ mode: z.literal('trailing'), asOf: day }),
]);

/** Exact dated spending only; missing statement history never becomes a zero year. */
export function annualComparison(report: WorkspaceReport, state: WorkspaceState, input: z.infer<typeof annualComparisonSchema>) {
  const request = annualComparisonSchema.parse(input);
  const previousYear = (value: string) => {
    const year = Number(value.slice(0,4)) - 1, month = Number(value.slice(5,7));
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return `${year}-${value.slice(5,7)}-${String(Math.min(Number(value.slice(8)),last)).padStart(2,'0')}`;
  };
  const nextDay = (value: string) => new Date(Date.parse(value+'T00:00:00Z')+86_400_000).toISOString().slice(0,10);
  const to = request.mode === 'calendar' ? `${request.year}-12-31` : request.asOf;
  const priorTo = previousYear(to);
  const from = request.mode === 'calendar' ? `${request.year}-01-01` : nextDay(priorTo);
  const priorFrom = request.mode === 'calendar' ? `${request.year-1}-01-01` : nextDay(previousYear(priorTo));
  const rows = effectiveRows(report,state).filter(r=>!r.excluded);
  const range = (from: string, to: string) => {
    const selected = rows.filter(r=>r.date>=from && r.date<=to);
    const coveredFrom = from > report.coverage.start ? from : report.coverage.start;
    const coveredTo = to < report.coverage.end ? to : report.coverage.end;
    const months = report.months.filter(m=>m.month>=from.slice(0,7) && m.month<=to.slice(0,7) && !m.manualOnly);
    const expectedMonths = (Number(to.slice(0,4))-Number(from.slice(0,4)))*12+Number(to.slice(5,7))-Number(from.slice(5,7))+1;
    const available = coveredFrom <= coveredTo && months.length > 0;
    const complete = available && coveredFrom === from && coveredTo === to && months.length === expectedMonths;
    // Legacy snapshots can carry refunds only as monthly totals. Never invent their dates.
    const refunds = months.filter(m=>m.grossSpending!==m.netSpending);
    const undatedRefunds = refunds.some(m=>from>m.month+'-01' || to<new Date(Date.UTC(Number(m.month.slice(0,4)),Number(m.month.slice(5)),0)).toISOString().slice(0,10));
    const categories = new Map<string,number>();
    for (const row of selected) categories.set(row.group,exactSum([categories.get(row.group)??0,row.eur]));
    if (!undatedRefunds && refunds.length) categories.set('Інші виплати',exactSum([categories.get('Інші виплати')??0,...refunds.map(m=>m.netSpending-m.grossSpending)]));
    const net = (available || selected.length) && !undatedRefunds ? exactSum([...categories.values()]) : null;
    return { from, to, coveredFrom: available ? coveredFrom : null, coveredTo: available ? coveredTo : null,
      complete: complete && !undatedRefunds, undatedRefunds, net, categories: Object.fromEntries(categories) };
  };
  const current = range(from,to), previous = range(priorFrom,priorTo);
  const comparable = current.complete && previous.complete && current.net !== null && previous.net !== null;
  const delta = comparable ? exactSum([current.net!,-previous.net!]) : null;
  const categories = [...new Set([...Object.keys(current.categories),...Object.keys(previous.categories)])].map(category=>{
    const a = current.net === null ? null : Object.hasOwn(current.categories,category) ? current.categories[category] : 0;
    const b = previous.net === null ? null : Object.hasOwn(previous.categories,category) ? previous.categories[category] : 0;
    return { category, current:a, previous:b, delta:comparable ? exactSum([a!,-b!]) : null };
  }).sort((a,b)=>(b.current??-Infinity)-(a.current??-Infinity)||a.category.localeCompare(b.category,'uk'));
  return { mode:request.mode,current,previous,delta,percent:delta!==null&&previous.net!>0 ? delta/previous.net!*100 : null,categories };
}
export function changeState(report: WorkspaceReport, state: WorkspaceState, mutation: Exclude<Mutation, {action:'undo'}>): WorkspaceState {
  const next = structuredClone(state);
  if (mutation.action === 'categoryName') {
    const categories = new Set([...Object.keys(report.plan), ...state.budgets.map(b=>b.category), ...effectiveRows(report,state).map(r=>r.group), ...Object.values(state.overrides).map(r=>r.category)]);
    if (!categories.has(mutation.category)) throw new Error('CATEGORY_NOT_FOUND');
    if (['__proto__','constructor','prototype'].includes(mutation.category)) throw new Error('CATEGORY_INVALID');
    const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase('uk-UA');
    if ([...categories].some(c=>c!==mutation.category && (normalize(c)===normalize(mutation.name) || normalize(Object.hasOwn(state.categoryNames,c)?state.categoryNames[c]:c)===normalize(mutation.name)))) throw new Error('CATEGORY_NAME_TAKEN');
    if (mutation.name===mutation.category) delete next.categoryNames[mutation.category];
    else next.categoryNames[mutation.category]=mutation.name;
  } else if (mutation.action === 'budget') {
    next.budgets = next.budgets.filter(b => b.category !== mutation.category || b.from !== mutation.from);
    next.budgets.push({ from: mutation.from, category: mutation.category, amount: mutation.amount });
  } else if (mutation.action === 'row') {
    if (!report.rows.some(r => r.id === mutation.id)) throw new Error('ROW_NOT_FOUND');
    if (['__proto__', 'constructor', 'prototype'].includes(mutation.id)) throw new Error('ID_INVALID');
    next.overrides[mutation.id] = { category: mutation.category, ...(mutation.name===undefined?{}:{name:mutation.name}), note: mutation.note, excluded: mutation.excluded };
    // Linked reimbursements follow the purchase category, even when received in a later month.
    for (const r of report.rows.filter(r => r.purchaseId === mutation.id)) {
      next.overrides[r.id] = { ...next.overrides[r.id], category: mutation.category, note: next.overrides[r.id]?.note ?? '', excluded: mutation.excluded };
    }
  } else if (mutation.action === 'collection') {
    const c = mutation.collection;
    const ids = new Set(c.rowIds);
    if (ids.size !== c.rowIds.length || c.rowIds.some(id => !report.rows.some(r => r.id === id))) throw new Error('LINK_INVALID');
    if (c.manualPayment && c.rowIds.some(id => report.rows.some(r => r.id === id && r.eur > 0))) throw new Error('MANUAL_PAYMENT_WITH_BANK_DEBIT');
    const occupied = next.collections.filter(other => other.id !== c.id && (other.kind === c.kind || (other.kind !== 'purchase' && c.kind !== 'purchase'))).flatMap(other => other.rowIds);
    if (occupied.some(id => ids.has(id))) throw new Error('LINK_ALREADY_ASSIGNED');
    next.collections = [...next.collections.filter(other => other.id !== c.id), c];
  } else {
    if (!next.collections.some(c => c.id === mutation.id)) throw new Error('COLLECTION_NOT_FOUND');
    next.collections = next.collections.filter(c => c.id !== mutation.id);
  }
  return stateSchema.parse(next);
}

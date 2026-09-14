import { z } from 'zod';
import {operationSplitSchema,expandOperationSplits,validateOperationSplits} from './operation-splits';
import {cryptoHistorySchema} from './crypto-history';
import {cashExpenseInputSchema,cashExpenseSchema} from './cash-expenses';

const cents = z.number().int().min(-1e12).max(1e12);
const positiveCents = cents.nonnegative();
const day = z.iso.date();
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u);
const text = z.string().trim().min(1).max(240);
const id = z.string().min(1).max(180);
const spendingType = z.enum(['transport','lodging','food','shopping','activities','settlement','other']);
const reportingScope = z.enum(['cashflow','trip_only','purchase_only']);
const operationType = z.enum(['expense','cash_fx','fx','excluded']);
const rowCorrection = z.object({ category: text, name: z.string().trim().max(4000).optional(), note: z.string().max(2000), excluded: z.boolean(), operationType: operationType.optional() })
  .refine(v=>v.operationType===undefined || v.excluded===(v.operationType!=='expense'),'OPERATION_TYPE_CONFLICT');
export const tripPaymentSchema = z.object({
  id, date: z.union([day,month]), eur: cents, description: z.string().trim().min(1).max(4000),
  payer: z.enum(['self','other']).optional(), payerName: z.string().max(120).optional(),
  disposition: z.enum(['expense','deposit']).optional(), spendingType: spendingType.optional(),
  amountBasis: z.enum(['original','historical']).optional(), reportingScope: reportingScope.optional(),
  linkedRowId: id.optional(), sourceRefs: z.array(z.record(z.string(),z.unknown())).optional(),
});
export type TripPayment = z.infer<typeof tripPaymentSchema>;
export const rowSchema = z.object({
  id, date: day, eur: cents, group: text, description: z.string().max(4000), provider: z.string().max(120),
  source: z.string().max(100), sourceRefs: z.array(z.record(z.string(), z.unknown())).default([]),
  nativeEur: cents.nullish(), nativeMinor: z.string().nullish(), currency: z.string().nullish(),
  originalCategory: z.string().nullish(), homeGroup: z.string().nullish(), trip: z.string().nullish(),
  aiProvider: z.string().optional(), creditId: id.optional(), purchaseId: id.optional(),
  adjustmentKind: z.string().optional(), excluded: z.boolean().default(false), unresolved: z.boolean().default(false),
  categoryPolicy: z.object({version:z.string(),rule:z.string()}).optional(),
  reportingScope: reportingScope.optional(), spendingType: spendingType.optional(),
  baseCategory: z.string().optional(), collectionId: id.optional(),
  amountBasis: z.enum(['original','historical']).optional(),
});
export type ReportRow = z.infer<typeof rowSchema> & {operationType?: z.infer<typeof operationType>;splitParent?:boolean;splitParentId?:string;splitPartId?:string};
// Acquisition evidence is descriptive only; it never generates ledger payments.
export const purchaseDetailsSchema = z.object({
  category: text, paidInCash: z.boolean().optional(),
  items: z.array(z.object({
    id, name: text, category: text,
    classification: z.enum(['source','inferred','user']),
    sourceTitle: z.string().max(2000),
    quantity: z.number().int().positive().max(10000).nullable(),
    displayedUnitPrice: positiveCents.nullable(),
    asin: z.string().regex(/^[A-Z0-9]{10}$/u).optional(),
    seller: text.optional(), sourceReference: id,
  })).max(200),
  sources: z.array(z.object({
    kind: z.enum(['amazon','workbook','confirmed']), label: text, reference: id,
    artifactHash: z.string().regex(/^[a-f0-9]{64}$/u),
    date: day.optional(), orderId: z.string().regex(/^\d{3}-\d{7}-\d{7}$/u).optional(),
    status: z.enum(['ordered','unknown','replacement']).optional(),
    amounts: z.array(z.object({label:text,eur:cents})).max(30),
  })).max(50),
});
export const collectionSchema = z.object({
  id, kind: z.enum(['trip', 'event', 'purchase']), name: text, start: day, end: day,
  budget: positiveCents.nullable(), note: z.string().max(2000).default(''),
  rowIds: z.array(id).max(2000), season: z.boolean().default(false),
  dateLabel: z.string().max(200).optional(),
  datePrecision: z.enum(['day','month','year']).optional(),
  referenceAmount: positiveCents.nullable().default(null),
  manualPayment: z.object({ date: day, eur: positiveCents.positive() }).nullable().default(null),
  payments: z.array(tripPaymentSchema).max(2000).optional(),
  coverageNote: z.string().max(1000).optional(),
  purchaseDetails: purchaseDetailsSchema.optional(),
  archived: z.boolean().optional(),
}).refine(v => v.end >= v.start, 'END_BEFORE_START');
export type Collection = z.infer<typeof collectionSchema>;
export const reportSchema = z.object({
  version: z.union([z.literal(1),z.literal(2)]), coverage: z.object({ start: day, end: day, generatedAt: z.string() }),
  rows: z.array(rowSchema), months: z.array(z.object({ month, income: cents, tax: cents, bank: cents, netSpending: cents,
    grossSpending: cents, partial: z.boolean(), unknown: cents.default(0), fx: cents.nullable().default(null), manualOnly: z.boolean().default(false) })),
  plan: z.record(text, positiveCents), collections: z.array(collectionSchema),
  sources: z.array(z.object({ name: text, sha256: z.string().regex(/^[a-f0-9]{64}$/u) })),
  costRows: z.array(z.object({ date: day, eur: cents, kind: z.enum(['tax','bank','fx']), label: text, sourceId: z.string().optional() })).default([]),
  ledgerDigest: z.string(),
  cryptoHistory: cryptoHistorySchema.optional(),
});
export type WorkspaceReport = z.infer<typeof reportSchema>;
const budgetPeriodSchema = z.object({ from: month, to: month.optional(), amount: positiveCents })
  .refine(v => v.to === undefined || v.to >= v.from, 'BUDGET_END_BEFORE_START');
const budgetSchema = budgetPeriodSchema.safeExtend({category:text});
const budgetPeriodsSchema = z.array(budgetPeriodSchema).max(200).refine(periods=>{
  const sorted=[...periods].sort((a,b)=>a.from.localeCompare(b.from));
  return sorted.every((p,i)=>i===0 || (sorted[i-1].to!==undefined && sorted[i-1].to!<p.from));
},'BUDGET_PERIODS_OVERLAP');
export const stateSchema = z.object({
  budgets: z.array(budgetSchema),
  budgetCategories: z.array(text).default([]),
  overrides: z.record(id, rowCorrection),
  operationSplits:z.record(id,operationSplitSchema).optional(),
  categoryNames: z.record(text, text).default({}),
  collections: z.array(collectionSchema),
  cashExpenses: z.array(cashExpenseSchema).max(20000).default([]),
});
export type WorkspaceState = z.infer<typeof stateSchema>;
export const mutationSchema = z.discriminatedUnion('action', [
  z.object({action:z.literal('operationSplit'),revision:z.number().int().nonnegative(),id,split:operationSplitSchema.nullable()}),
  budgetSchema.safeExtend({ action: z.literal('budget'), revision: z.number().int().nonnegative() }),
  z.object({action:z.literal('budgetPeriods'),revision:z.number().int().nonnegative(),category:text,periods:budgetPeriodsSchema}),
  rowCorrection.safeExtend({ action: z.literal('row'), revision: z.number().int().nonnegative(), id }),
  z.object({ action: z.literal('categoryName'), revision: z.number().int().nonnegative(), category: text, name: text }),
  z.object({ action: z.literal('collection'), revision: z.number().int().nonnegative(), collection: collectionSchema }),
  z.object({ action: z.literal('deleteCollection'), revision: z.number().int().nonnegative(), id }),
  z.object({ action: z.literal('cashExpense'), revision: z.number().int().nonnegative(), mode:z.enum(['create','update']), expense:cashExpenseInputSchema }),
  z.object({ action: z.literal('deleteCashExpense'), revision: z.number().int().nonnegative(), id }),
  z.object({ action: z.literal('undo'), revision: z.number().int().positive() }),
]);
export type Mutation = z.infer<typeof mutationSchema>;

export function exactSum(values: number[]): number {
  const total = values.reduce((a, b) => a + BigInt(b), 0n);
  if (total > BigInt(Number.MAX_SAFE_INTEGER) || total < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error('AMOUNT_OVERFLOW');
  return Number(total);
}
export function initialState(report: WorkspaceReport): WorkspaceState {
  return { budgets: [], budgetCategories:[], overrides: {}, categoryNames: {}, collections: structuredClone(report.collections), cashExpenses:[] };
}
export function spendingTypeFor(category: string): z.infer<typeof spendingType> {
  if (/продукт|їж|каф|рестора|кав|харч/iu.test(category)) return 'food';
  if (/житл|готел|прожив|оренд.*жит/iu.test(category)) return 'lodging';
  if (/покуп|технік|одяг|подар|дім/iu.test(category)) return 'shopping';
  if (/транспорт|пальне|авто|парку|авіа|дорог/iu.test(category)) return 'transport';
  if (/спорт|розваг|дозвіл|музе|актив/iu.test(category)) return 'activities';
  return 'other';
}
export function purchaseValue(row: ReportRow): {eur:number;estimated:boolean} {
  const native = row.nativeEur ?? (row.currency === 'EUR' && row.nativeMinor && /^-?\d+$/u.test(row.nativeMinor) ? Number(row.nativeMinor) : null);
  if (native !== null && native !== undefined && Number.isSafeInteger(native)) return {eur:Math.abs(native)*Math.sign(row.eur),estimated:row.amountBasis==='historical'};
  return {eur:row.eur,estimated:true};
}
export function isCashflowRow(row: ReportRow) { return !row.excluded && row.reportingScope !== 'trip_only' && row.reportingScope !== 'purchase_only'; }
const monthEnd = (value: string) => new Date(Date.UTC(Number(value.slice(0,4)),Number(value.slice(5,7)),0)).toISOString().slice(0,10);
export function rowInRange(row: ReportRow, from: string, to: string): boolean {
  return row.date.length === 7 ? row.date+'-01' >= from && monthEnd(row.date) <= to : row.date >= from && row.date <= to;
}
function undatedInRange(row: ReportRow, from: string, to: string): boolean {
  return row.date.length === 7 && row.date+'-01' <= to && monthEnd(row.date) >= from && !rowInRange(row,from,to);
}
export function effectiveRows(report: WorkspaceReport, state: WorkspaceState): ReportRow[] {
  const trips = new Map<string, string>();
  for (const c of state.collections.filter(c => c.kind === 'trip')) for (const id of c.rowIds) trips.set(id, c.name);
  const evidence = new Map(state.collections.flatMap(c=>(c.payments??[]).filter(p=>p.linkedRowId).map(p=>[p.linkedRowId!,p] as const)));
  const rows = report.rows.map<ReportRow>(row => {
    const edit = Object.hasOwn(state.overrides, row.id) ? state.overrides[row.id] : undefined;
    const trip = trips.get(row.id);
    const payment = evidence.get(row.id), baseCategory = edit?.category ?? row.homeGroup ?? row.group;
    const purchase = row.purchaseId ? report.rows.find(r=>r.id===row.purchaseId) : undefined;
    const excluded = (edit?.excluded ?? row.excluded) || payment?.payer==='other' || payment?.disposition==='deposit';
    const type = excluded ? (edit?.operationType && edit.operationType!=='expense' ? edit.operationType : edit?.excluded && edit.category==='Купівля валюти' ? 'fx' : 'excluded') : 'expense';
    return { ...row, group: trip ? 'Відпустки та подорожі' : (edit?.category ?? row.homeGroup ?? row.group),
      baseCategory, spendingType: edit?.category ? spendingTypeFor(baseCategory) : payment?.spendingType ?? row.spendingType ?? purchase?.spendingType ?? spendingTypeFor(baseCategory),
      description: edit?.name !== undefined ? edit.name || row.description : edit?.note || row.description,
      excluded, operationType: type, trip: trip ?? null };
  });
  for (const c of state.collections) if (c.manualPayment) rows.push({ id: `user:${c.id}`, date: c.manualPayment.date,
    eur: c.manualPayment.eur, group: c.kind === 'purchase' ? 'Покупки, техніка, одяг, подарунки, дім' : 'Відпустки та подорожі',
    description: c.name, provider: 'Ручна оплата', source: 'user', sourceRefs: [], trip: c.kind === 'trip' ? c.name : null,
    excluded: false, unresolved: false, baseCategory:'Інше',spendingType:'other' });
  for (const c of state.collections) for (const payment of c.payments??[]) {
    if (payment.linkedRowId || payment.payer==='other' || payment.disposition==='deposit') continue;
    rows.push({ id:`user:${c.id}:${payment.id}`,collectionId:c.id,date:payment.date,eur:payment.eur,nativeEur:payment.eur,
      amountBasis:payment.amountBasis??'original',reportingScope:payment.reportingScope??(report.months.some(m=>m.month===payment.date.slice(0,7))?'cashflow':'trip_only'),
      group:c.kind==='purchase'?'Покупки, техніка, одяг, подарунки, дім':'Відпустки та подорожі',baseCategory:payment.spendingType??'other',
      spendingType:payment.spendingType??'other',description:payment.description,provider:'Ручна оплата',source:'user',sourceRefs:payment.sourceRefs??[],
      trip:c.kind==='trip'?c.name:null,excluded:false,unresolved:false });
  }
  for(const expense of state.cashExpenses)rows.push({id:`cash:${expense.id}`,date:expense.date,eur:expense.eur,
    nativeMinor:String(-expense.amountMinor),currency:expense.currency,nativeEur:expense.currency==='EUR'?expense.amountMinor:null,
    group:expense.category,description:expense.description||expense.category,provider:`Готівка ${expense.currency}`,
    source:'manual_cash_expense',sourceRefs:[],excluded:false,unresolved:false,operationType:'expense',reportingScope:'cashflow'});
  return expandOperationSplits(rows,state).map(row=>row.splitParentId?{...row,spendingType:spendingTypeFor(row.group)}:row);
}
export function budgetFor(report: WorkspaceReport, state: WorkspaceState, category: string, month: string): number {
  const versions = state.budgets.filter(b => b.category === category && b.from <= month).sort((a,b) => b.from.localeCompare(a.from));
  const current = versions[0];
  return current ? (current.to && month > current.to ? 0 : current.amount) : (!state.budgetCategories.includes(category) && Object.hasOwn(report.plan, category) ? report.plan[category] : 0);
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
  for(const expense of state.cashExpenses){
    const month=expense.date.slice(0,7);
    if(!result.months.some(m=>m.month===month))result.months.push({month,income:0,tax:0,bank:0,netSpending:0,grossSpending:0,partial:true,unknown:0,fx:null,manualOnly:true});
    if(expense.date>result.coverage.end)result.coverage.end=expense.date;
    if(expense.date<result.coverage.start)result.coverage.start=expense.date;
  }
  result.months.sort((a,b)=>a.month.localeCompare(b.month));
  return result;
}
/** Collection dates are navigable even when there is no cashflow report for them. */
export function workspaceCalendar(report: WorkspaceReport, state: WorkspaceState) {
  const covered=reportingCoverage(report,state),months=new Set(covered.months.map(m=>m.month));
  let from=covered.coverage.start,to=covered.coverage.end;
  for(const collection of state.collections){
    if(collection.start<from)from=collection.start;
    if(collection.end>to)to=collection.end;
    const first=Number(collection.start.slice(0,4))*12+Number(collection.start.slice(5,7))-1;
    const last=Number(collection.end.slice(0,4))*12+Number(collection.end.slice(5,7))-1;
    for(let value=first;value<=last;value++)months.add(`${String(Math.floor(value/12)).padStart(4,'0')}-${String(value%12+1).padStart(2,'0')}`);
  }
  return {months:[...months].sort(),range:{from,to}};
}
const monthRangePattern = /^(\d{4}-(?:0[1-9]|1[0-2]))\.\.(\d{4}-(?:0[1-9]|1[0-2]))$/u;
const monthSpan = (range:{from:string;to:string}) => (Number(range.to.slice(0,4))-Number(range.from.slice(0,4)))*12+Number(range.to.slice(5,7))-Number(range.from.slice(5,7))+1;
function reportingRange(period:string, coverage:WorkspaceReport['coverage'], today:string) {
  if (period === 'all') return {from:coverage.start,to:coverage.end};
  const custom = monthRangePattern.exec(period);
  if (custom) {
    if (custom[1] > custom[2]) throw new Error('PERIOD_INVALID');
    return {from:`${custom[1]}-01`,to:monthEnd(custom[2])};
  }
  if (period === 'last12') {
    day.parse(today);
    const year=Number(today.slice(0,4)),month=Number(today.slice(5,7))-1;
    return {from:new Date(Date.UTC(year,month-11,1)).toISOString().slice(0,10),to:monthEnd(today.slice(0,7))};
  }
  if (!/^\d{4}(?:-(?:0[1-9]|1[0-2]))?$/u.test(period)) throw new Error('PERIOD_INVALID');
  return {from:period.length===4?period+'-01-01':period+'-01',to:period.length===4?period+'-12-31':monthEnd(period)};
}
export function comparisonFor(report: WorkspaceReport, state: WorkspaceState, period: string, end: string, today=new Date().toISOString().slice(0,10)) {
  if (period === 'all') return null;
  const range=reportingRange(period,report.coverage,today),annual=period.length===4||period==='last12'||monthRangePattern.test(period);
  if (period==='last12' && end.slice(0,7)!==today.slice(0,7)) return null;
  const start = period==='last12'?range.from:[range.from, report.coverage.start].sort().at(-1)!;
  const shift = (day: string) => {
    const d = new Date(day + 'T00:00:00Z');
    const year = d.getUTCFullYear() - (annual ? 1 : 0);
    const month = d.getUTCMonth() - (annual ? 0 : 1);
    const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    if (period.length === 7 && day === end && d.getUTCDate() === new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate()) {
      return new Date(Date.UTC(year,month,last)).toISOString().slice(0,10);
    }
    return new Date(Date.UTC(year, month, Math.min(d.getUTCDate(), last))).toISOString().slice(0,10);
  };
  const from = shift(start), to = shift(end);
  if (from < report.coverage.start || to > report.coverage.end) return null;
  const availableRows = effectiveRows(report,state).filter(isCashflowRow);
  const covered = (first: string, last: string) => {
    const months=report.months.filter(m=>!m.manualOnly && m.month>=first.slice(0,7) && m.month<=last.slice(0,7));
    const expected=(Number(last.slice(0,4))-Number(first.slice(0,4)))*12+Number(last.slice(5,7))-Number(first.slice(5,7))+1;
    return first>=report.coverage.start && last<=report.coverage.end && first<=last && months.length===expected
      && !availableRows.some(r=>undatedInRange(r,first,last))
      && !months.some(m=>m.grossSpending!==m.netSpending && (first>m.month+'-01' || last<new Date(Date.UTC(Number(m.month.slice(0,4)),Number(m.month.slice(5)),0)).toISOString().slice(0,10)));
  };
  if (!covered(start,end) || !covered(from,to)) return null;
  const rows = availableRows.filter(r => rowInRange(r,from,to));
  const refunds=exactSum(report.months.filter(m=>!m.manualOnly && m.month>=from.slice(0,7) && m.month<=to.slice(0,7)).map(m=>m.grossSpending-m.netSpending));
  return { period: `${from}–${to}`,
    from, to, refunds, net:exactSum(rows.map(r=>r.eur))-refunds, categories: [...new Set(rows.map(r=>r.group))].map(category=>({ category,
      actual: exactSum(rows.filter(r=>r.group===category).map(r=>r.eur)) })) };
}
export function summary(report: WorkspaceReport, state: WorkspaceState, period: string, today=new Date().toISOString().slice(0,10)) {
  const calendar=workspaceCalendar(report,state);
  report = reportingCoverage(report,state);
  const range=period==='all'?calendar.range:reportingRange(period,report.coverage,today);
  const inRange=(value:string)=>value.slice(0,7)>=range.from.slice(0,7)&&value.slice(0,7)<=range.to.slice(0,7);
  const months = report.months.filter(m => inRange(m.month));
  if (!months.length && period!=='last12' && !calendar.months.some(inRange)) throw new Error('PERIOD_UNAVAILABLE');
  const availableRange=months.length?{from:[months[0].month+'-01',report.coverage.start].sort().at(-1)!,to:[monthEnd(months.at(-1)!.month),report.coverage.end].sort()[0]}:null;
  const rows = effectiveRows(report, state).filter(r => inRange(r.date) && isCashflowRow(r));
  const original = report.rows.filter(r => inRange(r.date) && isCashflowRow(r));
  const refunds = exactSum(months.map(m => m.grossSpending - m.netSpending));
  const net = exactSum(rows.map(r => r.eur)) - refunds;
  const categories = [...new Set([...Object.keys(report.plan), ...state.budgetCategories, ...state.budgets.map(b => b.category), ...rows.map(r => r.group)])]
    .map(category => ({ category, actual: exactSum(rows.filter(r => r.group === category).map(r => r.eur)),
      plan: exactSum(months.map(m => budgetFor(report, state, category, m.month))) }));
  const income = exactSum(months.map(m => m.income)), tax = exactSum(months.map(m => m.tax)), bank = exactSum(months.map(m => m.bank));
  const fx = months.length && months.every(m => m.fx !== null) ? exactSum(months.map(m => m.fx!)) : null;
  return { period, range, availableRange, months, rows, categories, income, tax, bank, fx, net, refunds,
    manualOnly: months.every(m=>m.manualOnly),
    costRows: report.costRows.filter(r => inRange(r.date)),
    plan: exactSum(categories.map(c => c.plan)), remainder: income - net - tax - bank,
    unknown: exactSum(months.map(m => m.unknown)) - exactSum(rows.filter(r => r.unresolved).map(r => r.eur)),
    correctionDelta: exactSum(rows.map(r => r.eur)) - exactSum(original.map(r => r.eur)),
    partial: months.some(m => m.partial) || ((period.length === 4 || period==='last12') && months.length !== 12) || (monthRangePattern.test(period) && months.length !== monthSpan(range)),
  };
}
export function collectionTotals(c: Collection, rows: ReportRow[]) {
  const linked = rows.filter(r => (c.rowIds.includes(r.id) || r.id === `user:${c.id}` || r.collectionId===c.id) && !r.excluded);
  const values = linked.map(r=>({row:r,...(c.kind==='trip'?purchaseValue(r):{eur:r.eur,estimated:false})}));
  const types = new Map<string,number>();
  for (const value of values) { const type=value.row.spendingType??'other'; types.set(type,exactSum([types.get(type)??0,value.eur])); }
  return { paid:exactSum(values.filter(v=>v.eur>0).map(v=>v.eur)),recovered:-exactSum(values.filter(v=>v.eur<0).map(v=>v.eur)),
    net:exactSum(values.map(v=>v.eur)), count:linked.length,
    purchaseAmounts:{paid:exactSum(linked.filter(r=>r.eur>0).map(r=>purchaseValue(r).eur)),recovered:-exactSum(linked.filter(r=>r.eur<0).map(r=>purchaseValue(r).eur)),net:exactSum(linked.map(r=>purchaseValue(r).eur)),estimatedCount:linked.filter(r=>purchaseValue(r).estimated).length},
    nativeTotals:[...new Set(linked.filter(r=>r.nativeMinor&&r.currency).map(r=>r.currency!))].map(currency=>{const nativeRows=linked.filter(r=>r.currency===currency&&r.nativeMinor);return {currency,paidMinor:exactSum(nativeRows.filter(r=>r.eur>0||(r.eur===0&&r.splitParentId)).map(r=>Math.abs(Number(r.nativeMinor)))),recoveredMinor:exactSum(nativeRows.filter(r=>r.eur<0).map(r=>Math.abs(Number(r.nativeMinor)))),netMinor:exactSum(nativeRows.map(r=>Math.abs(Number(r.nativeMinor))*(Math.sign(r.eur)||(r.splitParentId?1:0)))),count:nativeRows.length};}),
    bankPaid:exactSum(linked.filter(r=>r.eur>0).map(r=>r.eur)),bankRecovered:-exactSum(linked.filter(r=>r.eur<0).map(r=>r.eur)),bankNet:exactSum(linked.map(r=>r.eur)),
    estimatedCount:values.filter(v=>v.estimated).length,types:[...types].map(([type,eur])=>({type,eur})).sort((a,b)=>b.eur-a.eur),
    rowIds:linked.map(r=>r.id),otherPaid:exactSum((c.payments??[]).filter(p=>p.payer==='other'&&p.disposition!=='deposit').map(p=>p.eur)),
    deposits:exactSum((c.payments??[]).filter(p=>p.disposition==='deposit').map(p=>p.eur)) };
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
  const rows = effectiveRows(report,state).filter(isCashflowRow);
  const range = (from: string, to: string) => {
    const selected = rows.filter(r=>rowInRange(r,from,to));
    const undatedExpenses = rows.some(r=>undatedInRange(r,from,to));
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
    const net = (available || selected.length) && !undatedRefunds && !undatedExpenses ? exactSum([...categories.values()]) : null;
    return { from, to, coveredFrom: available ? coveredFrom : null, coveredTo: available ? coveredTo : null,
      complete: complete && !undatedRefunds && !undatedExpenses, undatedRefunds, undatedExpenses, net, categories: Object.fromEntries(categories) };
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
export function changeState(report: WorkspaceReport, state: WorkspaceState, mutation: Exclude<Mutation, {action:'undo'|'cashExpense'}>): WorkspaceState {
  const next = structuredClone(state);
  if (mutation.action === 'categoryName') {
    const categories = new Set([...Object.keys(report.plan), ...state.budgetCategories, ...state.budgets.map(b=>b.category), ...effectiveRows(report,state).map(r=>r.group), ...Object.values(state.overrides).map(r=>r.category)]);
    if (!categories.has(mutation.category)) throw new Error('CATEGORY_NOT_FOUND');
    if (['__proto__','constructor','prototype'].includes(mutation.category)) throw new Error('CATEGORY_INVALID');
    const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase('uk-UA');
    if ([...categories].some(c=>c!==mutation.category && (normalize(c)===normalize(mutation.name) || normalize(Object.hasOwn(state.categoryNames,c)?state.categoryNames[c]:c)===normalize(mutation.name)))) throw new Error('CATEGORY_NAME_TAKEN');
    if (mutation.name===mutation.category) delete next.categoryNames[mutation.category];
    else next.categoryNames[mutation.category]=mutation.name;
  } else if (mutation.action === 'budgetPeriods') {
    const periods=budgetPeriodsSchema.parse(mutation.periods);
    next.budgets=[...next.budgets.filter(b=>b.category!==mutation.category),...periods.map(p=>({...p,category:mutation.category}))];
    next.budgetCategories=[...new Set([...next.budgetCategories,mutation.category])];
  } else if (mutation.action === 'budget') {
    next.budgets = next.budgets.filter(b => b.category !== mutation.category || b.from !== mutation.from);
    next.budgets.push(budgetSchema.parse(mutation));
  } else if (mutation.action === 'row') {
    const row = report.rows.find(r => r.id === mutation.id);
    if (!row) throw new Error('ROW_NOT_FOUND');
    if (['__proto__', 'constructor', 'prototype'].includes(mutation.id)) throw new Error('ID_INVALID');
    const previous = next.overrides[mutation.id];
    const type = mutation.operationType ?? (previous?.excluded===mutation.excluded ? previous.operationType : undefined);
    if (type==='cash_fx' && (row.eur<=0 || row.purchaseId)) throw new Error('CASH_FX_REQUIRES_DEBIT');
    next.overrides[mutation.id] = { category: mutation.category, ...(mutation.name===undefined?{}:{name:mutation.name}), note: mutation.note, excluded: mutation.excluded, ...(type?{operationType:type}:{}) };
    // Linked reimbursements follow the purchase category, even when received in a later month.
    for (const r of report.rows.filter(r => r.purchaseId === mutation.id)) {
      next.overrides[r.id] = { ...next.overrides[r.id], category: mutation.category, note: next.overrides[r.id]?.note ?? '', excluded: mutation.excluded, operationType:mutation.excluded?'excluded':'expense' };
    }
  } else if(mutation.action==='operationSplit'){
    if(['__proto__','constructor','prototype'].includes(mutation.id))throw new Error('ID_INVALID');
    next.operationSplits={...next.operationSplits};
    if(mutation.split)next.operationSplits[mutation.id]=mutation.split;else delete next.operationSplits[mutation.id];
  } else if (mutation.action === 'collection') {
    const c = mutation.collection;
    const ids = new Set(c.rowIds);
    if (ids.size !== c.rowIds.length || c.rowIds.some(id => !report.rows.some(r => r.id === id))) throw new Error('LINK_INVALID');
    if (c.manualPayment && c.rowIds.some(id => report.rows.some(r => r.id === id && r.eur > 0))) throw new Error('MANUAL_PAYMENT_WITH_BANK_DEBIT');
    if (c.manualPayment && c.payments?.length) throw new Error('MANUAL_PAYMENT_WITH_BANK_DEBIT');
    if (new Set((c.payments??[]).map(p=>p.id)).size !== (c.payments??[]).length) throw new Error('PAYMENT_ID_DUPLICATE');
    const paymentLinks = (c.payments??[]).flatMap(p=>p.linkedRowId?[p.linkedRowId]:[]);
    if (new Set(paymentLinks).size!==paymentLinks.length || paymentLinks.some(id=>!ids.has(id))) throw new Error('PAYMENT_LINK_INVALID');
    const occupied = next.collections.filter(other => other.id !== c.id && (other.kind === c.kind || (other.kind !== 'purchase' && c.kind !== 'purchase'))).flatMap(other => other.rowIds);
    if (occupied.some(id => ids.has(id))) throw new Error('LINK_ALREADY_ASSIGNED');
    next.collections = [...next.collections.filter(other => other.id !== c.id), c];
  } else {
    if(mutation.action==='deleteCashExpense'){
      if(!next.cashExpenses.some(e=>e.id===mutation.id))throw new Error('CASH_EXPENSE_NOT_FOUND');
      next.cashExpenses=next.cashExpenses.filter(e=>e.id!==mutation.id);
      return stateSchema.parse(next);
    }
    if (!next.collections.some(c => c.id === mutation.id)) throw new Error('COLLECTION_NOT_FOUND');
    next.collections = next.collections.filter(c => c.id !== mutation.id);
  }
  validateOperationSplits(report,next);
  return stateSchema.parse(next);
}

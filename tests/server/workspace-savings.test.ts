import { describe, expect, it } from 'vitest';
import type { CapitalPosition, CapitalView } from '@/server/read-model/finance-centers';
import { initialState, reportSchema } from '@/server/workspace/model';
import { accountSavings, savingsBridge, savingsView } from '@/server/workspace/savings';

const position = (id: string, providerCode: string, currency: string, native: string | null, rate: string | null, extra: Partial<CapitalPosition> = {}): CapitalPosition => ({
  id, name: `SYNTHETIC ${id}`, provider: providerCode, providerCode, scope: 'PERSONAL', type: 'bank', currency,
  nativeMinor: native, reportMinor: native === null || rate === null ? null : String(Math.round(Number(native) * Number(rate))),
  observedAt: '2090-01-31', source: 'synthetic', status: native === null ? 'missing_balance' : 'known', carriedForward: false,
  rate, rateSource: rate ? 'ECB' : null, publicationDate: rate ? '2090-01-31' : null, rateStale: false, accountId: id,
  precision: 'day', manualEvidence: null, ...extra,
});
const view = (asOf: string, positions: CapitalPosition[]): CapitalView => ({
  asOf, currency: 'EUR', positions, knownAssetsMinor: '0', knownLiabilitiesMinor: '0', knownNetMinor: '0',
  completeNetWorthMinor: null, unvaluedCount: 0, carriedForwardCount: 0,
});
const fixture = () => reportSchema.parse({version:1,coverage:{start:'2090-01-01',end:'2090-02-28',generatedAt:'2090-03-01'},ledgerDigest:'synthetic',sources:[],
  rows:[
    {id:'synthetic-book',date:'2090-01-12',eur:10000,group:'Books',homeGroup:'Books',description:'SYNTHETIC purchase',provider:'SYNTHETIC bank',source:'synthetic'},
    {id:'synthetic-refund',date:'2090-02-02',eur:-3000,group:'Books',homeGroup:'Books',description:'SYNTHETIC refund',provider:'SYNTHETIC bank',source:'synthetic',purchaseId:'synthetic-book'},
    {id:'synthetic-food',date:'2090-02-05',eur:5000,group:'Food',homeGroup:'Food',description:'SYNTHETIC groceries',provider:'SYNTHETIC bank',source:'synthetic'},
  ],months:[{month:'2090-01',income:50000,tax:1000,bank:20,netSpending:10000,grossSpending:10000,partial:false,fx:30},{month:'2090-02',income:50000,tax:0,bank:20,netSpending:1800,grossSpending:2000,partial:false,fx:10}],plan:{Books:6000,Food:7000},collections:[]});

describe('workspace savings',()=>{
  it('splits a foreign-currency balance change into money that stayed and EUR revaluation',()=>{
    const [wise] = accountSavings(view('2090-01-31',[position('wise-usd','wise','USD','100000','0.9')]), view('2090-02-28',[position('wise-usd','wise','USD','150000','0.95')]));
    expect(wise).toMatchObject({ workspace: true, startMinor: '90000', endMinor: '142500', changeMinor: '52500', revaluationMinor: '5000', savedMinor: '47500' });
  });

  it('keeps an account without a balance unknown instead of treating it as zero',()=>{
    const rows = accountSavings(view('2090-01-31',[position('erste','erste','EUR',null,null),position('revolut','revolut','EUR','1000','1')]),
      view('2090-02-28',[position('erste','erste','EUR','50000','1'),position('revolut','revolut','EUR','3000','1')]));
    expect(rows[0].savedMinor).toBeNull();
    expect(savingsBridge({remainder:10000,unknown:0,fx:0},rows)).toMatchObject({ saved: 2000, unknownAccounts: 1 });
  });

  it('explains the remainder with Privat/Mono/FOP changes, unassigned transfers and the FX estimate',()=>{
    const rows = accountSavings(
      view('2090-01-31',[position('erste','erste','EUR','100000','1'),position('privat','privatbank','UAH','1000000','0.02'),position('fop','privatbank','USD','0','0.9',{scope:'SOLE_PROPRIETOR'})]),
      view('2090-02-28',[position('erste','erste','EUR','150000','1'),position('privat','privatbank','UAH','2000000','0.02'),position('fop','privatbank','USD','0','0.9',{scope:'SOLE_PROPRIETOR'})]));
    expect(rows.map(r=>r.workspace)).toEqual([true,false,false]);
    expect(savingsBridge({remainder:100000,unknown:5000,fx:1000},rows)).toMatchObject({
      remainder:100000, otherAccounts:20000, unassigned:5000, fx:1000, expected:74000, saved:50000, unexplained:-24000, revaluation:0 });
  });

  it('reads balances on the day before the period and at every month end without crypto',async()=>{
    const balances: Record<string,string> = { '2089-12-31':'100000', '2090-01-31':'130000', '2090-02-28':'170000' };
    const requested: string[] = [];
    const centers = { capital: async (date?: string) => { requested.push(date!); return view(date!,[position('erste','erste','EUR',balances[date!]??null,'1')]); } };
    const report = fixture(), result = await savingsView(centers, report, initialState(report), '2090', '2090-03-05');
    expect(new Set(requested)).toEqual(new Set(['2089-12-31','2090-01-31','2090-02-28']));
    expect(result.bridge).toMatchObject({ remainder: 87160, saved: 70000, fx: 40 });
    expect(result.months.map(m=>[m.month,m.saved,m.remainder])).toEqual([['2090-01',30000,38980],['2090-02',40000,48180]]);
  });
});

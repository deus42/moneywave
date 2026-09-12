import { describe, expect, it } from 'vitest';
import { annualComparison, changeState, collectionSchema, collectionTotals, effectiveRows, initialState, reportSchema, reportingCoverage, summary } from '@/server/workspace/model';

const fixture = () => reportSchema.parse({
 version:2, coverage:{start:'2090-01-01',end:'2090-03-31',generatedAt:'2090-04-01'}, ledgerDigest:'synthetic',sources:[],plan:{'Відпустки та подорожі':20000},
 rows:[
  {id:'synthetic-flight',date:'2090-01-03',eur:12300,nativeEur:12000,group:'Транспорт',description:'SYNTHETIC flight',provider:'SYNTHETIC bank',source:'synthetic',spendingType:'transport'},
  {id:'synthetic-refund',date:'2090-03-05',eur:-4000,nativeMinor:'4000',currency:'EUR',purchaseId:'synthetic-flight',group:'Транспорт',description:'SYNTHETIC recovery',provider:'SYNTHETIC bank',source:'synthetic'},
  {id:'synthetic-history',date:'2089-06-11',eur:9000,nativeEur:8800,reportingScope:'trip_only',group:'Їжа',description:'SYNTHETIC historical meal',provider:'SYNTHETIC bank',source:'synthetic'},
 ], months:[
  {month:'2090-01',income:50000,tax:0,bank:0,netSpending:12300,grossSpending:12300,partial:false},
  {month:'2090-02',income:50000,tax:0,bank:0,netSpending:0,grossSpending:0,partial:false},
  {month:'2090-03',income:50000,tax:0,bank:0,netSpending:-4000,grossSpending:-4000,partial:false},
 ],collections:[{id:'synthetic-trip',kind:'trip',name:'SYNTHETIC trip',start:'2090-02-10',end:'2090-02-13',budget:20000,rowIds:['synthetic-flight','synthetic-refund'],payments:[
  {id:'synthetic-cash',date:'2090-02',eur:1700,description:'SYNTHETIC cash meal',spendingType:'food',sourceRefs:[{source:'synthetic sheet',row:7}]},
  {id:'synthetic-other',date:'2090-02-11',eur:5000,description:'SYNTHETIC companion payment',payer:'other',payerName:'SYNTHETIC companion'},
  {id:'synthetic-hold',date:'2090-02-11',eur:6000,description:'SYNTHETIC rental hold',disposition:'deposit'},
  {id:'synthetic-sheet-link',date:'2090-01-03',eur:11900,description:'SYNTHETIC rounded sheet flight',linkedRowId:'synthetic-flight',spendingType:'transport'},
 ]}],
});

describe('trip costs, manual evidence and coverage',()=>{
 it('uses purchase EUR for trips, settlement EUR for cashflow, and counts recoveries once',()=>{
  const report=fixture(),state=initialState(report),rows=effectiveRows(report,state);
  const total=collectionTotals(state.collections[0],rows);
  expect(total).toMatchObject({paid:13700,recovered:4000,net:9700,bankNet:10000,count:3,estimatedCount:0});
  expect(summary(report,state,'2090').net).toBe(10000);
  expect(summary(report,state,'2090-01').net).toBe(12300);
  expect(summary(report,state,'2090-02').net).toBe(1700);
  expect(summary(report,state,'2090-03').net).toBe(-4000);
  expect(summary(report,state,'2090').income).toBe(150000);
 });
 it('excludes companion payments, deposits and linked worksheet duplicates from own spending',()=>{
  const report=fixture(),state=initialState(report),rows=effectiveRows(report,state);
  expect(rows.filter(r=>r.collectionId==='synthetic-trip')).toHaveLength(1);
  expect(rows.find(r=>r.id==='user:synthetic-trip:synthetic-cash')?.date).toBe('2090-02');
  expect(collectionTotals(state.collections[0],rows).types).toEqual([{type:'transport',eur:8000},{type:'food',eur:1700}]);
 });
 it('keeps historical trip payments out of income coverage and monthly/yearly comparisons',()=>{
  const report=fixture(),state=initialState(report);
  state.collections.push(collectionSchema.parse({id:'synthetic-old',kind:'trip',name:'SYNTHETIC old trip',start:'2089-06-10',end:'2089-06-12',budget:null,rowIds:['synthetic-history'],payments:[{id:'synthetic-old-cash',date:'2089-06',eur:1000,description:'SYNTHETIC historical cash'}]}));
  expect(reportingCoverage(report,state).coverage).toEqual(report.coverage);
  expect(reportingCoverage(report,state).months).toHaveLength(3);
  expect(()=>summary(report,state,'2089')).toThrow('PERIOD_UNAVAILABLE');
  expect(annualComparison(report,state,{mode:'calendar',year:2090}).previous.net).toBeNull();
  expect(collectionTotals(state.collections[1],effectiveRows(report,state)).net).toBe(9800);
 });
 it('does not invent a day for a month-precision expense in a partial date comparison',()=>{
  const report=fixture(),state=initialState(report);
  const comparison=annualComparison(report,state,{mode:'trailing',asOf:'2090-02-15'});
  expect(comparison.current).toMatchObject({net:null,complete:false,undatedExpenses:true});
 });
 it('keeps the underlying category editable while charging the trip budget',()=>{
  const report=fixture();const state=changeState(report,initialState(report),{action:'row',revision:0,id:'synthetic-flight',category:'Покупки',note:'',excluded:false});
  const rows=effectiveRows(report,state);
  expect(rows.find(r=>r.id==='synthetic-flight')).toMatchObject({group:'Відпустки та подорожі',baseCategory:'Покупки',spendingType:'shopping'});
 });
 it('prevents reused payment identities and dangling bank links',()=>{
  const report=fixture(),state=initialState(report),c=state.collections[0];
  expect(()=>changeState(report,state,{action:'collection',revision:0,collection:{...c,payments:[c.payments![0],c.payments![0]]}})).toThrow('PAYMENT_ID_DUPLICATE');
  expect(()=>changeState(report,state,{action:'collection',revision:0,collection:{...c,payments:[{id:'synthetic-bad',date:'2090-02',eur:2000,description:'SYNTHETIC missing bank link',linkedRowId:'absent'}]}})).toThrow('PAYMENT_LINK_INVALID');
 });
 it('labels non-EUR fallback estimates and leaves purchase collection valuation unchanged',()=>{
  const report=fixture(),state=initialState(report);
  delete report.rows[0].nativeEur;
  const rows=effectiveRows(report,state),trip=state.collections[0];
  expect(collectionTotals(trip,rows)).toMatchObject({estimatedCount:1,net:10000});
  report.rows[0].nativeEur=12000;
  expect(collectionTotals({...trip,kind:'purchase'},effectiveRows(report,state)).net).toBe(10000);
 });
 it('reads version-one collections and their legacy manual payment without duplicating it',()=>{
  const report=fixture();report.version=1;
  report.collections=[collectionSchema.parse({id:'synthetic-legacy',kind:'purchase',name:'SYNTHETIC legacy',start:'2090-02-01',end:'2090-02-01',budget:null,rowIds:[],manualPayment:{date:'2090-02-01',eur:2500}})];
  const state=initialState(report);
  expect(collectionTotals(state.collections[0],effectiveRows(report,state)).net).toBe(2500);
 });
});

import {describe,it,expect} from 'vitest';
import {comparisonFor,initialState,reportSchema,summary} from '@/server/workspace/model';

const fixture=()=>reportSchema.parse({version:1,coverage:{start:'2088-01-01',end:'2089-09-08',generatedAt:'2090-01-01'},ledgerDigest:'synthetic',sources:[],plan:{Synthetic:1000},collections:[],
 months:Array.from({length:21},(_,i)=>({month:`${2088+Math.floor(i/12)}-${String(i%12+1).padStart(2,'0')}`,income:0,tax:0,bank:0,netSpending:0,grossSpending:0,partial:i===20})),
 rows:[['old','2088-01-15',1000],['refund','2088-01-16',-200],['included','2088-09-08',500],['later','2088-09-09',900],['current','2089-01-15',4000],['partial','2089-09-08',100],['excluded','2088-08-03',800]].map(([id,date,eur])=>({id:`synthetic-${id}`,date,eur,group:'Synthetic',description:'SYNTHETIC',provider:'SYNTHETIC',source:'synthetic',excluded:id==='excluded'}))});

describe('budget comparison follows the selected period',()=>{
 it('compares a partial year against the same prior-year dates and keeps plan and actual unchanged',()=>{
  const report=fixture(),state=initialState(report),before=structuredClone(report),budget=summary(report,state,'2089');
  const prior=comparisonFor(report,state,'2089','2089-09-08');
  expect(prior).toMatchObject({from:'2088-01-01',to:'2088-09-08',net:1300,refunds:0});
  expect(prior?.categories).toEqual([{category:'Synthetic',actual:1300}]);
  expect(budget.net-prior!.net).toBe(2800);expect(budget.plan).toBe(9000);expect(budget.net).toBe(4100);
  expect(report).toEqual(before);expect(summary(report,state,'2089')).toEqual(budget);
 });
 it('compares the same days of the preceding month and handles complete month boundaries',()=>{
  const report=fixture(),state=initialState(report);
  expect(comparisonFor(report,state,'2088-02','2088-02-08')).toMatchObject({from:'2088-01-01',to:'2088-01-08',net:0});
  expect(comparisonFor(report,state,'2088-02','2088-02-29')).toMatchObject({from:'2088-01-01',to:'2088-01-31',net:800});
 });
 it('deducts monthly refunds once alongside signed transaction refunds',()=>{
  const report=fixture();report.months[0].grossSpending=300;report.months[0].netSpending=200;
  const prior=comparisonFor(report,initialState(report),'2089','2089-09-08');
  expect(prior).toMatchObject({net:1200,refunds:100});
  expect(prior!.categories.reduce((sum,c)=>sum+c.actual,0)-prior!.refunds).toBe(prior!.net);
 });
 it('does not fabricate a comparison when history or an intermediate month is missing',()=>{
  const report=fixture(),state=initialState(report);
  expect(comparisonFor(report,state,'2088','2088-12-31')).toBeNull();
  report.months=report.months.filter(m=>m.month!=='2088-04');
  expect(comparisonFor(report,state,'2089','2089-09-08')).toBeNull();
 });
 it('rejects a gap in the current period as well as unallocated refunds without a known day',()=>{
  const report=fixture();report.months=report.months.filter(m=>m.month!=='2089-04');
  expect(comparisonFor(report,initialState(report),'2089','2089-09-08')).toBeNull();
  const partial=fixture();partial.months.at(-1)!.grossSpending=100;
  expect(comparisonFor(partial,initialState(partial),'2089','2089-09-08')).toBeNull();
 });
});

import {describe,expect,it} from 'vitest';
import {changeState,comparisonFor,initialState,reportSchema,summary} from '@/server/workspace/model';

const fixture=()=>{
 const months=Array.from({length:27},(_,i)=>new Date(Date.UTC(2088,i,1)).toISOString().slice(0,7));
 return reportSchema.parse({version:1,coverage:{start:'2088-01-01',end:'2090-03-31',generatedAt:'2090-04-01'},ledgerDigest:'synthetic',sources:[],collections:[],plan:{Books:1000},
  months:months.map(month=>({month,income:30000,tax:100,bank:20,netSpending:9500,grossSpending:10000,partial:false,fx:10})),
  rows:months.flatMap(month=>[
   {id:`synthetic-${month}-book`,date:month+'-12',eur:10000,group:'Books',description:'SYNTHETIC book',provider:'SYNTHETIC bank',source:'synthetic'},
   {id:`synthetic-${month}-refund`,date:month+'-13',eur:-2000,group:'Books',description:'SYNTHETIC refund',provider:'SYNTHETIC bank',source:'synthetic'},
   {id:`synthetic-${month}-transfer`,date:month+'-14',eur:50000,group:'Books',description:'SYNTHETIC transfer',provider:'SYNTHETIC bank',source:'synthetic',excluded:true},
  ]),costRows:months.map(month=>({date:month+'-12',eur:100,kind:'tax',label:'SYNTHETIC tax'}))});
};

describe('last twelve calendar months including the current month',()=>{
 it('anchors to the supplied current clock, crosses years and excludes older and future months',()=>{
  const report=fixture(),state=initialState(report),before=structuredClone(report);
  const rolling=summary(report,state,'last12','2090-01-16');
  expect(rolling.range).toEqual({from:'2089-02-01',to:'2090-01-31'});
  expect(rolling.months.map(m=>m.month)).toEqual(['2089-02','2089-03','2089-04','2089-05','2089-06','2089-07','2089-08','2089-09','2089-10','2089-11','2089-12','2090-01']);
  expect(rolling).toMatchObject({period:'last12',net:90000,refunds:6000,income:360000,tax:1200,bank:240,fx:120,remainder:268560,partial:false});
  expect(rolling.rows).toHaveLength(24);expect(rolling.costRows).toHaveLength(12);
  expect(rolling.net).toBe(rolling.months.reduce((n,m)=>n+summary(report,state,m.month).net,0));
  expect(rolling.categories.reduce((n,c)=>n+c.actual,0)-rolling.refunds).toBe(rolling.net);
  expect(report).toEqual(before);
 });
 it('uses the effective budget for each selected month and handles leap-year ends',()=>{
  const report=fixture(),state=changeState(report,initialState(report),{action:'budget',revision:0,category:'Books',from:'2089-07',amount:2000});
  expect(summary(report,state,'last12','2090-01-16').plan).toBe(19000);
  expect(summary(report,state,'last12','2088-02-16').range).toEqual({from:'2087-03-01',to:'2088-02-29'});
 });
 it('retains the requested window when data is old, sparse or absent instead of shifting to the newest import',()=>{
  const report=fixture(),state=initialState(report);
  const partial=summary(report,state,'last12','2090-09-16');
  expect(partial.range).toEqual({from:'2089-10-01',to:'2090-09-30'});
  expect(partial.availableRange).toEqual({from:'2089-10-01',to:'2090-03-31'});
  expect(partial.months).toHaveLength(6);expect(partial.partial).toBe(true);
  const empty=summary(report,state,'last12','2092-09-16');
  expect(empty.months).toEqual([]);expect(empty.availableRange).toBeNull();expect(empty.partial).toBe(true);
  report.months=report.months.filter(m=>m.month!=='2089-05');
  expect(summary(report,state,'last12','2090-01-16').partial).toBe(true);
 });
 it('compares the same window one year earlier only when both histories are covered',()=>{
  const report=fixture(),state=initialState(report);
  expect(comparisonFor(report,state,'last12','2090-01-31','2090-01-16')).toMatchObject({from:'2088-02-01',to:'2089-01-31',net:90000,refunds:6000});
  report.months=report.months.filter(m=>m.month!=='2088-05');
  expect(comparisonFor(report,state,'last12','2090-01-31','2090-01-16')).toBeNull();
 });
 it('does not compare a truncated current window as a complete year',()=>{
  const report=fixture(),state=initialState(report);
  expect(comparisonFor(report,state,'last12','2090-03-31','2090-09-16')).toBeNull();
 });
});

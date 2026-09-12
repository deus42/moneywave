import { describe, expect, it } from 'vitest';
import { changeState, comparisonFor, initialState, reportSchema, summary } from '@/server/workspace/model';

const fixture=()=>reportSchema.parse({version:1,coverage:{start:'2089-12-01',end:'2090-01-31',generatedAt:'2090-02-01'},ledgerDigest:'synthetic',sources:[],collections:[],plan:{Books:1000},
 rows:[
  {id:'synthetic-book',date:'2089-12-12',eur:10000,group:'Books',homeGroup:'Books',description:'SYNTHETIC book',provider:'Synthetic bank',source:'synthetic'},
  {id:'synthetic-refund',date:'2090-01-12',eur:-2000,group:'Books',homeGroup:'Books',description:'SYNTHETIC refund',provider:'Synthetic bank',source:'synthetic',purchaseId:'synthetic-book'},
  {id:'synthetic-food',date:'2090-01-13',eur:7000,group:'Food',homeGroup:'Food',description:'SYNTHETIC food',provider:'Synthetic bank',source:'synthetic'},
  {id:'synthetic-transfer',date:'2090-01-14',eur:50000,group:'Books',homeGroup:'Books',description:'SYNTHETIC transfer',provider:'Synthetic bank',source:'synthetic',excluded:true},
 ],months:[
  {month:'2089-12',income:30000,tax:100,bank:20,grossSpending:10000,netSpending:10000,fx:10,partial:false},
  {month:'2090-01',income:40000,tax:200,bank:30,grossSpending:5000,netSpending:4500,fx:null,partial:false},
 ]});

describe('whole reporting history',()=>{
 it('sums each monthly flow once across year boundaries and preserves refunds and exclusions',()=>{
  const report=fixture(),original=structuredClone(report),state=initialState(report),all=summary(report,state,'all');
  expect(all.months.map(m=>m.month)).toEqual(['2089-12','2090-01']);
  expect(all.rows.map(r=>r.id)).not.toContain('synthetic-transfer');
  expect(all).toMatchObject({period:'all',net:14500,refunds:500,income:70000,tax:300,bank:50,remainder:55150,fx:null});
  expect(all.net).toBe(summary(report,state,'2089-12').net+summary(report,state,'2090-01').net);
  expect(all.categories.reduce((n,c)=>n+c.actual,0)-all.refunds).toBe(all.net);
  expect(report).toEqual(original);
 });
 it('applies the budget effective in each month instead of repeating one current limit',()=>{
  const report=fixture(),state=changeState(report,initialState(report),{action:'budget',revision:0,category:'Books',from:'2090-01',amount:1500});
  expect(summary(report,state,'all').categories.find(c=>c.category==='Books')?.plan).toBe(2500);
 });
 it('does not invent a previous period for the entire available history',()=>{
  const report=fixture();
  expect(comparisonFor(report,initialState(report),'all','2090-01-31')).toBeNull();
 });
 it('still rejects malformed or unavailable periods',()=>{
  const report=fixture(),state=initialState(report);
  expect(()=>summary(report,state,'ALL')).toThrow('PERIOD_INVALID');
  expect(()=>summary(report,state,'2090-13')).toThrow('PERIOD_INVALID');
  expect(()=>summary(report,state,'2088')).toThrow('PERIOD_UNAVAILABLE');
 });
});

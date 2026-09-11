import {describe,it,expect} from 'vitest';
import {annualComparison,initialState,reportSchema,changeState} from '@/server/workspace/model';
const fixture=()=>reportSchema.parse({version:1,coverage:{start:'2087-01-01',end:'2089-12-31',generatedAt:'2090-01-01'},ledgerDigest:'synthetic',sources:[],plan:{},collections:[],
 months:Array.from({length:36},(_,i)=>({month:`${2087+Math.floor(i/12)}-${String(i%12+1).padStart(2,'0')}`,income:0,tax:0,bank:0,netSpending:0,grossSpending:0,partial:false})),
 rows:[['old','2087-06-15',1000],['previous','2088-06-15',2000],['leap','2088-02-29',700],['boundary','2088-07-01',300],['current','2089-06-15',5000],['refund','2089-06-18',-400],['excluded','2089-06-20',10000]].map(([id,date,eur])=>({id:`synthetic-${id}`,date,eur,group:'Synthetic',description:'SYNTHETIC',provider:'SYNTHETIC',source:'synthetic',excluded:id==='excluded'}))});
describe('annual spending comparison',()=>{
 it('compares complete calendar years, including signed refunds and saved exclusions',()=>{
  const r=fixture();const result=annualComparison(r,initialState(r),{mode:'calendar',year:2089});
  expect(result.current).toMatchObject({from:'2089-01-01',to:'2089-12-31',net:4600,complete:true});
  expect(result.previous).toMatchObject({from:'2088-01-01',to:'2088-12-31',net:3000,complete:true});
  expect(result.delta).toBe(1600);expect(result.categories[0]).toMatchObject({current:4600,previous:3000,delta:1600});
 });
 it('uses consecutive non-overlapping trailing years ending on the selected date',()=>{
  const r=fixture();const result=annualComparison(r,initialState(r),{mode:'trailing',asOf:'2089-06-30'});
  expect(result.current).toMatchObject({from:'2088-07-01',to:'2089-06-30',net:4900,complete:true});
  expect(result.previous).toMatchObject({from:'2087-07-01',to:'2088-06-30',net:2700,complete:true});
 });
 it('labels incomplete statement coverage and never turns absent history into a zero comparison',()=>{
  const r=fixture();r.coverage.start='2088-04-01';r.coverage.end='2089-06-30';r.rows=r.rows.filter(x=>x.date>=r.coverage.start&&x.date<=r.coverage.end);
  const result=annualComparison(r,initialState(r),{mode:'calendar',year:2089});
  expect(result.current.complete).toBe(false);expect(result.current.coveredTo).toBe('2089-06-30');
  expect(result.previous.complete).toBe(false);expect(result.delta).toBeNull();
  const absent=annualComparison(r,initialState(r),{mode:'calendar',year:2088});expect(absent.previous.net).toBeNull();
 });
 it('clamps leap day and keeps the adjacent intervals contiguous',()=>{
  const r=fixture();const result=annualComparison(r,initialState(r),{mode:'trailing',asOf:'2088-02-29'});
  expect(result.current.from).toBe('2087-03-01');expect(result.previous.to).toBe('2087-02-28');
  expect(()=>annualComparison(r,initialState(r),{mode:'trailing',asOf:'2089-02-29'})).toThrow();
 });
 it('keeps gaps in monthly evidence incomplete and handles user categories named like object properties',()=>{
  const r=fixture();r.months=r.months.filter(m=>m.month!=='2089-04');r.rows[1].group='constructor';
  const result=annualComparison(r,initialState(r),{mode:'calendar',year:2089});
  expect(result.current.complete).toBe(false);expect(result.delta).toBeNull();
  expect(result.categories.find(c=>c.category==='constructor')).toMatchObject({current:0,previous:2000,delta:null});
 });
 it('includes manual event spending in the consolidated travel category',()=>{
  const r=fixture(),state=changeState(r,initialState(r),{action:'collection',revision:0,collection:{id:'synthetic-event',kind:'event',name:'SYNTHETIC event',start:'2089-04-03',end:'2089-04-03',budget:null,note:'',rowIds:[],season:false,referenceAmount:null,manualPayment:{date:'2089-04-03',eur:800}}});
  const result=annualComparison(r,state,{mode:'calendar',year:2089});
  expect(result.current.net).toBe(5400);expect(result.categories.find(c=>c.category==='Відпустки та подорожі')?.current).toBe(800);
 });
 it('uses current category edits and does not prorate legacy monthly refunds to arbitrary dates',()=>{
  const r=fixture();r.months.find(m=>m.month==='2089-06')!.grossSpending=500;r.months.find(m=>m.month==='2089-06')!.netSpending=400;
  const state=changeState(r,initialState(r),{action:'row',revision:0,id:'synthetic-current',category:'Edited',note:'',excluded:false});
  const result=annualComparison(r,state,{mode:'trailing',asOf:'2089-06-30'});expect(result.current.net).toBe(4800);expect(result.categories.find(c=>c.category==='Edited')?.current).toBe(5000);
  const partial=annualComparison(r,state,{mode:'trailing',asOf:'2089-06-20'});expect(partial.current.net).toBeNull();expect(partial.delta).toBeNull();
 });
});

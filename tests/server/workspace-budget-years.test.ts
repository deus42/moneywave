import {describe,expect,it} from 'vitest';
import {budgetYears} from '@/server/workspace/budget-years';
import {changeState,initialState,reportSchema} from '@/server/workspace/model';

const fixture=()=>reportSchema.parse({version:1,coverage:{start:'2089-01-01',end:'2090-06-30',generatedAt:'2090-07-01'},ledgerDigest:'synthetic',sources:[],collections:[],plan:{Books:1000},
 months:Array.from({length:18},(_,i)=>({month:`${2089+Math.floor(i/12)}-${String(i%12+1).padStart(2,'0')}`,income:0,tax:0,bank:0,grossSpending:0,netSpending:0,partial:false})),
 rows:[{id:'synthetic-book',date:'2089-03-01',eur:8000,group:'Books',description:'SYNTHETIC',provider:'SYNTHETIC',source:'synthetic'},
 {id:'synthetic-refund',date:'2089-04-01',eur:-1000,group:'Books',description:'SYNTHETIC',provider:'SYNTHETIC',source:'synthetic'},
 {id:'synthetic-new',date:'2090-03-01',eur:9000,group:'Books',description:'SYNTHETIC',provider:'SYNTHETIC',source:'synthetic'}]});

describe('annual budget outcomes',()=>{
 it('compares full-year plans with exact outcomes and leaves partial or future deviations unknown',()=>{
  const report=fixture(),state=changeState(report,initialState(report),{action:'budgetPeriods',revision:0,category:'Books',periods:[
   {from:'2089-01',to:'2089-12',amount:1000},{from:'2090-01',to:'2090-12',amount:2000},{from:'2091-01',to:'2091-12',amount:3000}]});
  const years=budgetYears(report,state,'2090-07-01');
  expect(years.find(y=>y.year===2089)).toMatchObject({plan:12000,actual:7000,variance:-5000,complete:true,coveredMonths:12,monthlyPlan:1000,monthlyActual:7000/12});
  expect(years.find(y=>y.year===2090)).toMatchObject({plan:24000,actual:9000,variance:null,complete:false,coveredMonths:6,monthlyActual:null});
  expect(years.find(y=>y.year===2091)).toMatchObject({plan:36000,actual:null,variance:null,complete:false,coveredMonths:0});
  expect(years.find(y=>y.year===2089)?.categories).toContainEqual({category:'Books',plan:12000,actual:7000,variance:-5000});
 });
 it('keeps missing months and explicitly partial months incomplete',()=>{
  const report=fixture();report.months=report.months.filter(m=>m.month!=='2089-05');
  expect(budgetYears(report,initialState(report),'2090-07-01').find(y=>y.year===2089)?.variance).toBeNull();
  const partial=fixture();partial.months[0].partial=true;
  expect(budgetYears(partial,initialState(partial),'2090-07-01').find(y=>y.year===2089)?.complete).toBe(false);
 });
 it('shows independent complete years with correct category totals and unallocated refunds',()=>{
  const report=fixture();report.coverage.end='2090-12-31';
  report.months.push(...Array.from({length:6},(_,i)=>({month:`2090-${String(i+7).padStart(2,'0')}`,income:0,tax:0,bank:0,grossSpending:0,netSpending:0,partial:false,unknown:0,fx:null,manualOnly:false})));
  report.months[0].grossSpending=500;report.months[0].netSpending=400;
  const years=budgetYears(report,initialState(report),'2091-01-01'),old=years.find(y=>y.year===2089)!,current=years.find(y=>y.year===2090)!;
  expect(old.categories.reduce((n,c)=>n+(c.actual??0),0)).toBe(old.actual);
  expect(current.actual!-old.actual!).toBe(2100);
  expect(current.variance).toBe(-3000);
 });
});

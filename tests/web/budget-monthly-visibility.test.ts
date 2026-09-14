import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {describe,expect,it} from 'vitest';
import {changeState,initialState,reportSchema,summary} from '@/server/workspace/model';

const source=readFileSync('src/web/app.js','utf8');
const euro=source.split('\n').find(line=>line.startsWith('const euro ='))!;
const renderers=source.slice(source.indexOf('function budgetSummary('),source.indexOf('function budgetChanges('));
const report=reportSchema.parse({version:1,coverage:{start:'2090-01-01',end:'2090-03-31',generatedAt:'2090-04-01'},ledgerDigest:'synthetic',sources:[],rows:[],collections:[],plan:{'SYNTHETIC Books':10000},
 months:['2090-01','2090-03'].map(month=>({month,income:0,tax:0,bank:0,grossSpending:0,netSpending:0,partial:false}))});
const state=changeState(report,initialState(report),{action:'budget',revision:0,category:'SYNTHETIC Books',from:'2090-03',amount:30000});
function render(period:string,cell=false,plan?:number){
 const view=summary(report,state,period,'2090-04-01');
 return runInNewContext(euro+'\n'+renderers+`\n${cell?'budgetMonthlyCell(plan)':'budgetSummary()'}`,{
  view,plan:plan??view.categories[0].plan,budgetPeriodRange:()=>view.availableRange,date:(v:string)=>v,budgetBar:()=>'',
 }) as string;
}

describe('monthly budget visibility',()=>{
 it('shows the effective selected-month plan without an average or duplicate period amount',()=>{
  expect(render('2090-03')).toContain('Бюджет на місяць');
  expect(render('2090-03')).not.toContain('Середній');
  expect(render('2090-03',true)).toContain('>€300</span>');
  expect(render('2090-03',true)).not.toContain('за період');
  expect(render('2090-01',true)).toContain('>€100</span>');
 });
 it.each(['all','2090','2090-01..2090-03'])('labels the average for %s using only months included in the protected plan',period=>{
  const html=render(period);
  expect(html).toContain('Середній бюджет / місяць');
  expect(html).toContain('<strong>€200</strong>');
  expect(html).toContain('План за 2 міс. із даними ÷ 2');
  const cell=render(period,true);
  expect(cell).toContain('Середній / міс.');
  expect(cell).toContain('>€200</span>');
  expect(cell).toContain('€400 за період');
 });
 it('renders a filtered total from its own plan without changing the monthly denominator',()=>{
  expect(render('all',true,20000)).toContain('>€100</span>');
  expect(render('all',true,20000)).toContain('€200 за період');
 });
 it('keeps an unset category budget distinct from spending',()=>{
  expect(render('2090-03',true,0)).toContain('class="bg-monthly-value">—</span>');
  expect(render('all',true,0)).not.toMatch(/NaN|Infinity/u);
 });
});

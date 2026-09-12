import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {describe,expect,it} from 'vitest';

const source=readFileSync('src/web/app.js','utf8');
const declaration=(name:string)=>source.split('\n').find(line=>line.startsWith(`const ${name} =`)||line.startsWith(`function ${name}(`))!;
const note=source.slice(source.indexOf('function costsNote('),source.indexOf('function spendComparison('));
const detailStart=source.indexOf('function showCosts(');
const detail=source.slice(detailStart,source.indexOf('\n}',detailStart)+2);
function render(fx:number|null,income=100000){
 let html='';
 const context={view:{fx,income,tax:5000,bank:1000,manualOnly:false,costRows:[]},
  open:(_title:string,value:string)=>{html=value;},titlePeriod:()=> 'SYNTHETIC period'};
 const overview=runInNewContext(['esc','euro','percent','line','stats'].map(declaration).join('\n')+'\n'+note+detail+'\nshowCosts(); costsNote();',context) as string;
 return {html,overview};
}

describe('FX estimate share of period income',()=>{
 it('shows the FX component share separately from the combined cost share',()=>{
  const {html,overview}=render(1250);
  expect(html).toMatch(/FX · оцінка[^<]*1,25% доходу/u);
  expect(html).toContain('7,25%');
  expect(overview).toContain('FX €13 (1,25% доходу)');
 });
 it('retains a measured zero percentage',()=>{
  const {html,overview}=render(0);
  expect(html).toMatch(/FX · оцінка[^<]*0% доходу/u);
  expect(overview).toContain('FX €0 (0% доходу)');
 });
 it('does not present a missing estimate as zero',()=>{
  const {html,overview}=render(null);
  expect(html).toMatch(/FX · оцінка[^<]*—/u);
  expect(html).not.toMatch(/FX · оцінка[^<]*0%/u);
  expect(overview).toContain('FX без оцінки');
 });
 it.each([0,-100000])('does not divide by nonpositive income %s',income=>{
  const {html,overview}=render(1250,income);
  expect(html).toMatch(/FX · оцінка[^<]*—/u);
  expect(html).not.toMatch(/NaN|Infinity/u);
  expect(overview).toBe('');
 });
});

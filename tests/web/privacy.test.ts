import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {describe,it,expect} from 'vitest';

const source=readFileSync('src/web/privacy.js','utf8').replaceAll('export function','function');
const {maskFinancialText,amountPreference}=runInNewContext(source+'\n({maskFinancialText,amountPreference})') as {
 maskFinancialText:(text:string)=>string;
 amountPreference:(storage:{getItem:(key:string)=>string|null})=>boolean;
};

describe('amount privacy presentation',()=>{
 it('hides financial amounts in either currency order, localized separators and signs',()=>{
  for(const text of ['€12 345,67','−€58,90','+€123','$1,234.56','£12.50','12\u00a0345,67 UAH','55 USD','500 грн.','1,25 ETH','80 USDC','35%','−12,5%'])expect(maskFinancialText(text),text).toBe('****');
 });
 it('retains dates, record counts, words and spacing around hidden money',()=>{
  expect(maskFinancialText('20.07–05.08.2024 · 81 оплат · €123,45 після повернень')).toBe('20.07–05.08.2024 · 81 оплат · **** після повернень');
  expect(maskFinancialText('Зміна +€10 · +15% · 3 записи')).toBe('Зміна **** · **** · 3 записи');
  expect(maskFinancialText('2024 · EUR · 01.09.2026 — 08.09.2026')).toBe('2024 · EUR · 01.09.2026 — 08.09.2026');
  expect(maskFinancialText('€1 000 із €2 000')).toBe('**** із ****');
 });
 it('masks chart accessibility and note text without losing the label',()=>{
  expect(maskFinancialText('09.2090: 120,50 EUR; залишок €70,25')).toBe('09.2090: ****; залишок ****');
  expect(maskFinancialText('Дохід 45%; витрати 55%')).toBe('Дохід ****; витрати ****');
 });
 it('restores the remembered preference and stays usable when storage is unavailable',()=>{
  expect(amountPreference({getItem:()=>null})).toBe(false);
  expect(amountPreference({getItem:()=>'true'})).toBe(true);
  expect(amountPreference({getItem:()=>'false'})).toBe(false);
  expect(amountPreference({getItem:()=>{throw Error('storage denied');}})).toBe(false);
 });
});

import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {describe,expect,it} from 'vitest';

const source=readFileSync('src/web/app.js','utf8');
const readMonth=runInNewContext(source.slice(source.indexOf('function budgetMonthValue('),source.indexOf('function setBudgetMonthValue('))+'\nbudgetMonthValue') as (row:{querySelector:(selector:string)=>{value:string}},name:string)=>string|null;
const value=(month:string,year:string)=>readMonth({querySelector:selector=>({value:selector.includes('Month')?month:year})},'budgetFrom');

describe('explicit budget month and year fields',()=>{
 it('serializes the independently edited year and month with month precision',()=>{
  expect(value('04','2093')).toBe('2093-04');
  expect(value('12','2087')).toBe('2087-12');
  expect(value('01','9999')).toBe('9999-01');
 });
 it('distinguishes an open end from a partially entered boundary',()=>{
  expect(value('','')).toBe('');
  expect(value('04','')).toBeNull();
  expect(value('','2093')).toBeNull();
 });
 it('rejects malformed or out-of-range years and months instead of silently changing them',()=>{
  for(const year of ['0','10000','2e3','2090.5','-10'])expect(value('01',year)).toBeNull();
  for(const month of ['00','13','4'])expect(value(month,'2093')).toBeNull();
 });
});

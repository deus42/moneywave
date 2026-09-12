import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {describe,expect,it} from 'vitest';

const source=readFileSync('src/web/app.js','utf8');
const declaration=(name:string)=>source.split('\n').find(line=>line.startsWith(`const ${name} =`))!;
const summary=source.slice(source.indexOf('function collectionSummary('),source.indexOf('function tripCollections('));
const list=source.slice(source.indexOf('function tripCollections('),source.indexOf('function tripView('));
const category='Відпустки та подорожі';
const trips:{id:string;budget:number|null;end:string;net:number}[]=[{id:'SYNTHETIC TRIP',budget:1000,end:'2090-03-12',net:2500}];
function render(plan:number|null,selected=trips,categoryBudget=true){
 const context={view:{categories:plan===null?[]:[{category,plan}]},totals:(c:{net:number})=>({net:c.net}),selected,category};
 return runInNewContext(['esc','euro'].map(declaration).join('\n')+'\n'+summary+`\ncollectionSummary(selected${categoryBudget?',category':''});`,context) as string;
}

describe('trip summary category budget',()=>{
 it('shows the category period plan instead of summing individual trip budgets',()=>{
  const html=render(90000);
  expect(html).toContain('Бюджет категорії');
  expect(html).toContain('€900');
  expect(html).toContain(`data-budget="${category}"`);
  expect(html).not.toContain('Понад бюджет');
  expect(html).not.toContain('Залишилось');
 });
 it('keeps the category budget when filtering trips or when no trips match',()=>{
  expect(render(90000,[])).toContain('€900');
  expect(render(90000,[{...trips[0],budget:null}])).toContain('€900');
 });
 it.each([null,0])('keeps an unavailable category limit %s as a dash',plan=>{
  const html=render(plan);
  expect(html).toContain('Бюджет категорії');
  expect(html).toMatch(/data-budget="[^"]+"[^>]*>—<\/button>/u);
  expect(html).not.toContain('€10');
 });
 it('preserves the existing purchase collection budget behavior',()=>{
  const html=render(90000,trips,false);
  expect(html).toContain('€10');
  expect(html).toContain('Понад бюджет');
  expect(html).not.toContain('Бюджет категорії');
 });
 it('renders the category summary even for an empty trips list',()=>{
  const calls:unknown[][]=[];
  runInNewContext(list+'\ntripCollections();',{
   selectedCollections:()=>[],heading:()=>'',collectionToolbar:()=>'',collectionEmpty:()=>'',
   collectionSummary:(...args:unknown[])=>{calls.push(args);return '';},period:'all',allCollections:false,
  });
  expect(calls).toEqual([[[],category]]);
 });
});

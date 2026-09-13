import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {describe,expect,it} from 'vitest';
const source=readFileSync('src/web/app.js','utf8');
const functions=source.slice(source.indexOf('function purchaseReference('),source.indexOf('function purchaseView('));
const esc=(v:unknown)=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
const api=runInNewContext(functions+'\n({purchaseReference,purchaseItems})',{esc,euro:(v:number)=>String(v),date:(v:string)=>v,line:(label:string,amount:number)=>`${esc(label)}:${amount}`});
const item={id:'synthetic',name:'<script>SYNTHETIC</script>',category:'Synthetic tools',classification:'inferred',sourceTitle:'SYNTHETIC original <img>',quantity:1,displayedUnitPrice:5000};
describe('purchase source rendering',()=>{
 it('edits item labels without discarding source evidence, quantities or prices',()=>{
  const details={category:'Synthetic equipment',items:[item],sources:[{reference:'synthetic-source'}]};
  const {purchaseItemsFromForm}=runInNewContext(functions+'\n({purchaseItemsFromForm})',{workspace:{state:{collections:[{id:'synthetic',purchaseDetails:details}]}}});
  const form={dataset:{id:'synthetic'},querySelector:()=>({value:'Renamed category'}),querySelectorAll:()=>[{dataset:{purchaseItem:'0'},querySelector:(selector:string)=>({value:selector==='[name=itemName]'?'Renamed synthetic item':'Renamed item category'})}]};
  const result=purchaseItemsFromForm(form);
  expect(result.items[0]).toEqual({...item,name:'Renamed synthetic item',category:'Renamed item category',classification:'user'});
  expect(result.sources).toEqual(details.sources);expect(details.items[0]).toEqual(item);
 });
 it('escapes untrusted titles and distinguishes source amounts from payments',()=>{
  const html=api.purchaseItems({purchaseDetails:{category:'Synthetic equipment',items:[item],sources:[]}});
  expect(html).toContain('&lt;script>');expect(html).not.toContain('<script>');expect(html).toContain('Суми джерел не додаються до витрат');
 });
 it('keeps replacements out of the reference total and preserves zero and unknown',()=>{
  const c={referenceAmount:1700,purchaseDetails:{sources:[{kind:'amazon',status:'ordered',amounts:[{label:'Grand Total',eur:2300}]},{kind:'amazon',status:'replacement',amounts:[{label:'Grand Total',eur:0}]}]}};
  expect(api.purchaseReference(c)).toBe(2300);
  expect(api.purchaseReference({...c,purchaseDetails:{sources:[{kind:'amazon',amounts:[]}]}})).toBeNull();
  expect(api.purchaseReference({referenceAmount:0})).toBe(0);
  expect(api.purchaseReference({})).toBeNull();
 });
});

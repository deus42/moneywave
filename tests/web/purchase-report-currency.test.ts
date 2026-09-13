import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {describe,it,expect} from 'vitest';
const source=readFileSync('src/web/app.js','utf8');
const money=source.slice(source.indexOf('function purchaseRowMoney('),source.indexOf('function canSplit('));
const euro=(v:number)=>`€${(v/100).toFixed(2)}`;
describe('purchase reporting currency',()=>{
 it('uses the same EUR valuation for payments and totals despite different native and seller prices',()=>{
  const {purchaseRowMoney,purchaseMoney}=runInNewContext(money+'\n({purchaseRowMoney,purchaseMoney})',{euro});
  const payment={eur:2500,currency:'UAH',nativeMinor:'-123400',purchaseValue:{eur:2400,estimated:false}};
  const refund={eur:-500,currency:'UAH',nativeMinor:'24680',purchaseValue:{eur:-480,estimated:false}};
  const totals={paid:2500,recovered:500,net:2000,count:2,purchaseAmounts:{paid:2400,recovered:480,net:1920,estimatedCount:0},nativeTotals:[{currency:'UAH',paidMinor:123400,recoveredMinor:24680,netMinor:98720,count:2}]};
  expect(purchaseRowMoney(payment)).toBe('€25.00');expect(purchaseRowMoney(refund)).toBe('€-5.00');
  expect(purchaseMoney(totals,'paid')).toBe('€25.00');expect(purchaseMoney(totals,'recovered')).toBe('€5.00');expect(purchaseMoney(totals,'net')).toBe('€20.00');
 });
 it('shows allocated EUR parts and sums only confirmed spending while retaining native evidence',()=>{
  let html='';const parent={id:'synthetic',description:'SYNTHETIC transfer',date:'2090-01-01',eur:301,nativeMinor:'-10000'};
  const parts=[{splitParentId:parent.id,description:'SYNTHETIC expense',eur:201,nativeMinor:'-6700',excluded:false,group:'Synthetic'},{splitParentId:parent.id,description:'SYNTHETIC unknown',eur:100,nativeMinor:'-3300',excluded:true,unresolved:true}];
  const helpers=source.slice(source.indexOf('function operationSplitView('),source.indexOf('function splitPartFields('));
  const {operationSplitView}=runInNewContext(helpers+'\n({operationSplitView})',{workspace:{state:{operationSplits:{synthetic:{currency:'UAH',parts:[]}}}},allRows:()=>parts,euro,cashMoney:(v:number,c:string)=>`${v/100} ${c}`,date:(v:string)=>v,esc:(v:string)=>v,categoryName:(v:string)=>v,operationPurchaseLinks:()=>'',originalOperationDescription:()=>'',open:(_title:string,value:string)=>{html=value;}});
  operationSplitView(parent);expect(html).toContain('<strong>€3.01</strong>');expect(html).toContain('<b>€2.01</b>');expect(html).toContain('<b>€1.00</b>');expect(html).toContain('Підтверджені витрати: <b>€2.01</b>');expect(html).toContain('Оригінал: 100 UAH');expect(html).toContain('Оригінал: 67 UAH');expect(html).toContain('поза підтвердженими витратами');
 });
});

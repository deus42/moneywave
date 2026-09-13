import {describe,expect,it} from 'vitest';
import {collectionSchema,rowSchema} from '../../src/server/workspace/model';
import {purchaseLinkAudit} from '../../src/server/workspace/purchase-links';
const row=(extra={})=>rowSchema.parse({id:'synthetic-row',date:'2090-01-02',eur:10200,nativeEur:10000,group:'Synthetic',description:'AMAZON SYNTHETIC',provider:'synthetic',source:'ledger',...extra});
const collection=(extra={})=>collectionSchema.parse({id:'synthetic-buy',kind:'purchase',name:'Synthetic buy',start:'2090-01-01',end:'2090-01-01',budget:null,rowIds:['synthetic-row'],purchaseDetails:{category:'Synthetic',items:[],sources:[{kind:'amazon',label:'Synthetic order',reference:'synthetic',artifactHash:'a'.repeat(64),amounts:[{label:'Grand Total',eur:10000}]}]},...extra});
describe('purchase transaction link audit',()=>{
 it('checks native amounts, not converted report spending, and rechecks after amount changes',()=>{
  expect(purchaseLinkAudit([collection()],[row()]).links['synthetic-buy']).toMatchObject({status:'matched',amountVerified:true,transactionCount:1});
  expect(purchaseLinkAudit([collection()],[row({nativeEur:9900})]).links['synthetic-buy']).toMatchObject({status:'review',reason:'amount_mismatch'});
  expect(purchaseLinkAudit([collection()],[row({nativeEur:null})]).links['synthetic-buy']).toMatchObject({status:'review',reason:'amount_unavailable'});
 });
 it('does not let a renamed operation hide a different original merchant',()=>{
  expect(purchaseLinkAudit([collection()],[row()],[row({description:'SYNTHETIC other merchant'})]).links['synthetic-buy'].reason).toBe('merchant_mismatch');
 });
 it('does not confuse manual payments, adjustments, missing references or refunds with bank debits',()=>{
  expect(purchaseLinkAudit([collection({rowIds:[],manualPayment:{date:'2090-01-01',eur:10000}})],[]).links['synthetic-buy'].status).toBe('unmatched');
  expect(purchaseLinkAudit([collection()],[row({source:'report_adjustment'})]).links['synthetic-buy'].status).toBe('unmatched');
  expect(purchaseLinkAudit([collection()],[]).links['synthetic-buy'].reason).toBe('missing_row');
  expect(purchaseLinkAudit([collection()],[row({eur:-10000})]).links['synthetic-buy'].reason).toBe('no_debit');
  expect(purchaseLinkAudit([collection()],[row({excluded:true})]).links['synthetic-buy'].reason).toBe('no_debit');
 });
 it('detects duplicate purchase links and ignores zero-price replacements in source totals',()=>{
  const c=collection(),second=collection({id:'synthetic-second'});
  expect(purchaseLinkAudit([c,second],[row()]).links[c.id].reason).toBe('shared_row');
  c.purchaseDetails!.sources.push({...c.purchaseDetails!.sources[0],reference:'replacement',status:'replacement',amounts:[{label:'Grand Total',eur:0}]});
  expect(purchaseLinkAudit([c],[row()]).links[c.id].amountVerified).toBe(true);
 });
 it('flags unmatched retailer payments while preserving clearly identified subscriptions and links',()=>{
  const rows=[row(),row({id:'prime',description:'AMAZON PRIME'}),row({id:'music',description:'Amazon Music'}),row({id:'refund',eur:-10000}),row({id:'other',description:'Synthetic other shop'})];
  expect(purchaseLinkAudit([],rows).unmatchedRetailerRows).toEqual(['synthetic-row']);
  expect(purchaseLinkAudit([collection()],rows).unmatchedRetailerRows).toEqual([]);
 });
});

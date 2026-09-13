import {describe,expect,it} from 'vitest';
import {collectionSchema,collectionTotals,effectiveRows,initialState,reportSchema,rowSchema,summary} from '../../src/server/workspace/model';
import {purchaseLinkAudit} from '../../src/server/workspace/purchase-links';

describe('historical purchase payment evidence',()=>{
 it('keeps a real historical debit visible to its purchase without changing report cashflow',()=>{
  const row=rowSchema.parse({id:'synthetic-historical-bank',date:'2089-06-16',eur:10100,nativeEur:10000,group:'Synthetic',description:'AMAZON SYNTHETIC',provider:'synthetic',source:'ledger',reportingScope:'purchase_only'});
  const c=collectionSchema.parse({id:'synthetic-buy',kind:'purchase',name:'Synthetic',start:row.date,end:row.date,budget:null,rowIds:[row.id],purchaseDetails:{category:'Synthetic',items:[],sources:[{kind:'amazon',label:'Synthetic order',reference:'synthetic',artifactHash:'a'.repeat(64),amounts:[{label:'Grand Total',eur:10000}]}]}});
  const report=reportSchema.parse({version:2,coverage:{start:'2090-01-01',end:'2090-01-31',generatedAt:'2090-02-01'},rows:[],months:[{month:'2090-01',income:100000,tax:0,bank:0,netSpending:0,grossSpending:0,partial:false}],plan:{},collections:[c],sources:[],ledgerDigest:'synthetic'}),state=initialState(report);
  const before=summary(report,state,'all');report.rows.push(row);
  const after=summary(report,state,'all');expect(after.net).toBe(before.net);expect(after.categories).toEqual(before.categories);expect(after.rows).toEqual(before.rows);
  const rows=effectiveRows(report,state);expect(rows).toHaveLength(1);expect(collectionTotals(c,rows).count).toBe(1);expect(purchaseLinkAudit([c],rows).links[c.id]).toMatchObject({status:'matched',amountVerified:true});
 });
 it('marks confirmed cash without creating a bank link or an expense',()=>{
  const c=collectionSchema.parse({id:'synthetic-cash-buy',kind:'purchase',name:'Synthetic service',start:'2090-01-01',end:'2090-01-01',budget:null,rowIds:[],purchaseDetails:{category:'Synthetic',items:[],sources:[],paidInCash:true}});
  expect(purchaseLinkAudit([c],[]).links[c.id]).toMatchObject({status:'cash',reason:'cash_confirmed',transactionCount:0});
 });
 it('recognizes a preserved ZEN statement payment as bank evidence',()=>{
  const row=rowSchema.parse({id:'synthetic-zen',date:'2090-01-01',eur:10000,group:'Synthetic',description:'SYNTHETIC AIRLINE',provider:'zen',source:'zen_statement'});
  const c=collectionSchema.parse({id:'synthetic-buy',kind:'purchase',name:'Synthetic tickets',start:row.date,end:row.date,budget:null,rowIds:[row.id]});
  expect(purchaseLinkAudit([c],[row]).links[c.id]).toMatchObject({status:'matched',transactionCount:1});
 });
});

import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe,it,expect} from 'vitest';
import {openEncryptedDatabase} from '../../src/server/db/database';
import {applyMigrations} from '../../src/server/db/migrations';
import {WorkspaceStore} from '../../src/server/workspace/store';
import {reportSchema,collectionSchema,initialState,changeState,effectiveRows,isCashflowRow,collectionTotals,summary} from '../../src/server/workspace/model';
import {allocateValuation,operationSplitSchema} from '../../src/server/workspace/operation-splits';
import {purchaseLinkAudit} from '../../src/server/workspace/purchase-links';

const purchases=['synthetic-auto','synthetic-gift'].map(id=>collectionSchema.parse({id,kind:'purchase',name:id,start:'2090-01-02',end:'2090-01-02',budget:null,rowIds:[],referenceAmount:999}));
const report=()=>reportSchema.parse({version:2,coverage:{start:'2090-01-01',end:'2090-01-31',generatedAt:'2090-02-01'},rows:[{id:'synthetic-debit',date:'2090-01-02',eur:101,nativeMinor:'-10000',currency:'UAH',group:'Інші виплати',description:'SYNTHETIC mixed payment',provider:'synthetic',source:'ledger'}],months:[{month:'2090-01',income:0,tax:0,bank:0,netSpending:101,grossSpending:101,partial:false}],plan:{},collections:purchases,sources:[],ledgerDigest:'synthetic'});
const split=()=>operationSplitSchema.parse({currency:'UAH',note:'SYNTHETIC: cash received; cost, date and change unknown. No balance adjustment.',parts:[{id:'a',name:'Synthetic part A',amountMinor:3300,kind:'expense',category:'Авто',collectionId:purchases[0].id},{id:'b',name:'Synthetic part B',amountMinor:3300,kind:'expense',category:'Подарунки',collectionId:purchases[1].id},{id:'c',name:'Synthetic unresolved remainder',amountMinor:3400,kind:'unresolved',category:'Інші виплати'}]});
const apply=(r=report(),s=split())=>changeState(r,initialState(r),{action:'operationSplit',revision:0,id:'synthetic-debit',split:s});

describe('native operation allocations',()=>{
 it('conserves original debit and report valuation while counting confirmed parts once',()=>{
  const r=report(),before=structuredClone(r),state=apply(r),rows=effectiveRows(r,state),children=rows.filter(r=>r.splitParentId);
  expect(r).toEqual(before);expect(rows[0]).toMatchObject({eur:101,nativeMinor:'-10000',excluded:true,splitParent:true});
  expect(children.map(r=>r.eur)).toEqual([33,33,35]);expect(children.reduce((n,r)=>n+Number(r.nativeMinor),0)).toBe(-10000);
  expect(rows.filter(isCashflowRow).reduce((n,r)=>n+r.eur,0)).toBe(66);
  expect(children.filter(r=>!r.excluded).reduce((n,r)=>n-Number(r.nativeMinor),0)).toBe(6600);
  expect(children[2]).toMatchObject({excluded:true,unresolved:true,collectionId:undefined,nativeEur:null});
  expect(state.cashExpenses).toEqual([]);expect(state.collections).toEqual(before.collections);
  const totals=collectionTotals(purchases[0],rows);
  expect(totals).toMatchObject({count:1,net:33,bankNet:33,nativeTotals:[{currency:'UAH',netMinor:3300,count:1}],purchaseAmounts:{estimatedCount:1}});
  const audit=purchaseLinkAudit(state.collections,rows,r.rows);
  expect(audit.links[purchases[0].id]).toMatchObject({status:'matched',transactionCount:1});
  expect(audit.links[purchases[1].id].status).toBe('matched');
  expect(audit.rowLinks['synthetic-debit']).toEqual(purchases.map(p=>p.id));
  expect(audit.rowLinks['split:synthetic-debit:a']).toEqual([purchases[0].id]);
  expect(summary(r,state,'all').net).toBe(66);
 });
 it('uses stable IDs for rounding ties, including tiny report valuations',()=>{
  const parts=split().parts;
  const r=report();r.rows[0].eur=1;const rows=effectiveRows(r,apply(r));expect(collectionTotals(purchases[0],rows).nativeTotals[0].netMinor).toBe(3300);expect(purchaseLinkAudit(purchases,rows).links[purchases[0].id].status).toBe('matched');
  expect(allocateValuation(1,parts)).toEqual([0,0,1]);
  const first=allocateValuation(101,parts),reordered=[parts[2],parts[1],parts[0]];
  expect(allocateValuation(101,reordered)).toEqual([first[2],first[1],first[0]]);
  for(let total=0;total<200;total++)expect(allocateValuation(total,parts).reduce((a,b)=>a+b,0)).toBe(total);
 });
 it('rejects contradictory amounts, currencies, links and unsupported parent rows',()=>{
  const s=split();expect(()=>apply(report(),{...s,parts:s.parts.map((p,i)=>({...p,amountMinor:p.amountMinor+(i?0:1)}))})).toThrow('SPLIT_TOTAL_MISMATCH');
  expect(()=>apply(report(),{...s,currency:'EUR'})).toThrow('SPLIT_CURRENCY_MISMATCH');
  expect(()=>operationSplitSchema.parse({...s,parts:[s.parts[0],s.parts[0]]})).toThrow();
  expect(()=>operationSplitSchema.parse({...s,parts:s.parts.map(p=>({...p,amountMinor:0}))})).toThrow();
  for(const patch of [{nativeMinor:null},{nativeMinor:'10000'},{eur:-101},{source:'report_adjustment'},{excluded:true},{purchaseId:'other'}]){const r=report();Object.assign(r.rows[0],patch);expect(()=>apply(r)).toThrow();}
  const linked=report();linked.collections[0].rowIds=['synthetic-debit'];expect(()=>apply(linked)).toThrow('SPLIT_PARENT_ALREADY_LINKED');
  expect(()=>apply(report(),{...s,parts:s.parts.map(p=>({...p,collectionId:p.collectionId??'missing'}))})).toThrow('SPLIT_PURCHASE_INVALID');
  const r=report(),state=apply(r);expect(()=>changeState(r,state,{action:'deleteCollection',revision:0,id:purchases[0].id})).toThrow('SPLIT_PURCHASE_INVALID');
  expect(()=>changeState(r,state,{action:'collection',revision:0,collection:{...purchases[0],manualPayment:{date:'2090-01-02',eur:1}}})).toThrow('SPLIT_PURCHASE_INVALID');
 });
 it('retains exact seller EUR separately from budgeting and manual historical price',()=>{
  const r=report();Object.assign(r.rows[0],{nativeEur:99});r.collections[0].rowIds=['synthetic-debit'];
  const totals=collectionTotals(r.collections[0],effectiveRows(r,initialState(r)));
  expect(totals).toMatchObject({net:101,purchaseAmounts:{net:99,estimatedCount:0}});expect(r.collections[0].referenceAmount).toBe(999);
 });
 it('atomically persists edits, cancellation, undo and rejects stale or orphaning updates',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'moneywave-split-synthetic-')),path=join(directory,'test.db'),key=Buffer.alloc(32,69);
  let db=await openEncryptedDatabase(path,key);
  try{
   await applyMigrations(db);let store=new WorkspaceStore(db);await store.seed(report());
   await store.mutate({action:'operationSplit',revision:0,id:'synthetic-debit',split:split()});
   await db.close();db=await openEncryptedDatabase(path,key);store=new WorkspaceStore(db);
   const saved=await store.read();expect(saved.state.operationSplits?.['synthetic-debit']).toEqual(split());
   const edited=split();edited.parts[0].amountMinor=3200;edited.parts[2].amountMinor=3500;edited.parts[0].collectionId=purchases[1].id;
   await store.mutate({action:'operationSplit',revision:1,id:'synthetic-debit',split:edited});
   expect((await store.read()).state.operationSplits?.['synthetic-debit'].parts[0]).toEqual(edited.parts[0]);
   await store.mutate({action:'undo',revision:2});expect((await store.read()).state.operationSplits).toEqual(saved.state.operationSplits);
   await expect(store.mutate({action:'operationSplit',revision:1,id:'synthetic-debit',split:null})).rejects.toThrow('REVISION_CONFLICT');
   await store.mutate({action:'operationSplit',revision:3,id:'synthetic-debit',split:null});
   expect(summary((await store.read()).report,(await store.read()).state,'all').net).toBe(101);
   await store.mutate({action:'undo',revision:4});expect((await store.read()).state.operationSplits).toEqual(saved.state.operationSplits);
   const refreshed=report();refreshed.rows[0].nativeMinor='-10001';await expect(store.seed(refreshed,true)).rejects.toThrow('SPLIT_TOTAL_MISMATCH');
   expect((await store.read()).revision).toBe(5);
   await store.mutate({action:'collection',revision:5,collection:{...purchases[1],note:'Synthetic unrelated edit'}});
   expect((await store.read()).state.operationSplits).toEqual(saved.state.operationSplits);
   const current=await store.read();await store.reconcile(current.report,current.state,current.revision);
   expect((await store.read()).state.operationSplits).toEqual(saved.state.operationSplits);
  }finally{await db.close();await rm(directory,{recursive:true,force:true});key.fill(0);}
 });
});

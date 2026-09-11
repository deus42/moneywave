import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { get } from 'node:http';
import { openEncryptedDatabase, type EncryptedDatabase } from '@/server/db/database';
import { applyMigrations } from '@/server/db/migrations';
import { WorkspaceStore } from '@/server/workspace/store';
import { changeState, collectionTotals, comparisonFor, effectiveRows, initialState, reportSchema, stateSchema, summary } from '@/server/workspace/model';
import { createWorkspaceServer } from '@/server/workspace/http';
import { FinanceCenters } from '@/server/read-model/finance-centers';

const fixture = () => reportSchema.parse({version:1,coverage:{start:'2090-01-01',end:'2090-02-28',generatedAt:'2090-03-01'},ledgerDigest:'synthetic',sources:[],
 rows:[
 {id:'synthetic-book',date:'2090-01-12',eur:10000,group:'Books',homeGroup:'Books',description:'SYNTHETIC purchase',provider:'SYNTHETIC bank',source:'synthetic'},
 {id:'synthetic-refund',date:'2090-02-02',eur:-3000,group:'Books',homeGroup:'Books',description:'SYNTHETIC refund',provider:'SYNTHETIC bank',source:'synthetic',purchaseId:'synthetic-book'},
 {id:'synthetic-food',date:'2090-02-05',eur:5000,group:'Food',homeGroup:'Food',description:'SYNTHETIC groceries',provider:'SYNTHETIC bank',source:'synthetic'},
 ],months:[{month:'2090-01',income:50000,tax:1000,bank:20,netSpending:10000,grossSpending:10000,partial:false,fx:30},{month:'2090-02',income:50000,tax:0,bank:20,netSpending:1800,grossSpending:2000,partial:false,fx:10}],plan:{Books:6000,Food:7000},collections:[]});

describe('workspace financial projection',()=>{
 it('renames categories without moving rows, plans or financial history',()=>{
  const report=fixture(),before=structuredClone(report),state=initialState(report);
  const renamed=changeState(report,state,{action:'categoryName',revision:0,category:'Books',name:'Reading'});
  expect(renamed.categoryNames).toEqual({Books:'Reading'});
  expect(summary(report,renamed,'2090')).toEqual(summary(report,state,'2090'));
  expect(comparisonFor(report,renamed,'2090-02','2090-02-28')).toEqual(comparisonFor(report,state,'2090-02','2090-02-28'));
  expect(report).toEqual(before);
  expect(changeState(report,renamed,{action:'categoryName',revision:1,category:'Books',name:'Books'}).categoryNames).toEqual({});
  expect(()=>changeState(report,renamed,{action:'categoryName',revision:1,category:'Food',name:'reading'})).toThrow('CATEGORY_NAME_TAKEN');
  expect(()=>changeState(report,state,{action:'categoryName',revision:0,category:'Books',name:'food'})).toThrow('CATEGORY_NAME_TAKEN');
  expect(()=>changeState(report,state,{action:'categoryName',revision:0,category:'Missing',name:'New'})).toThrow('CATEGORY_NOT_FOUND');
 });
 it('keeps operation names separate from notes and preserves named refunds when recategorizing',()=>{
  const report=fixture();let state=initialState(report);
  state=changeState(report,state,{action:'row',revision:0,id:'synthetic-refund',category:'Books',name:'Synthetic recovery title',note:'Synthetic refund note',excluded:false});
  state=changeState(report,state,{action:'row',revision:1,id:'synthetic-book',category:'Equipment',name:'Synthetic purchase title',note:'Synthetic personal note',excluded:false});
  expect(effectiveRows(report,state).find(r=>r.id==='synthetic-book')?.description).toBe('Synthetic purchase title');
  expect(effectiveRows(report,state).find(r=>r.id==='synthetic-refund')?.description).toBe('Synthetic recovery title');
  expect(state.overrides['synthetic-refund'].note).toBe('Synthetic refund note');
  expect(summary(report,state,'2090').categories.find(c=>c.category==='Equipment')?.actual).toBe(7000);
  expect(report.rows[0].description).toBe('SYNTHETIC purchase');
  const legacy=stateSchema.parse({budgets:[],collections:[],overrides:{'synthetic-book':{category:'Books',note:'Legacy title',excluded:false}}});
  expect(legacy.categoryNames).toEqual({});expect(effectiveRows(report,legacy)[0].description).toBe('Legacy title');
 });
 it('adds period flows once and keeps unallocated refunds separate',()=>{
  const report=fixture(),state=initialState(report),year=summary(report,state,'2090');
  expect(year.net).toBe(11800);expect(year.income).toBe(100000);expect(year.remainder).toBe(87160);expect(year.fx).toBe(40);expect(year.plan).toBe(26000);expect(year.partial).toBe(true);
  expect(year.categories.reduce((a,c)=>a+c.actual,0)-year.refunds).toBe(year.net);
  expect(year.net).toBe(summary(report,state,'2090-01').net+summary(report,state,'2090-02').net);
 });
 it('tracks a purchase and a trip without adding their amounts to cash spending',()=>{
  const report=fixture();let state=initialState(report);
  state=changeState(report,state,{action:'collection',revision:0,collection:{id:'book',kind:'purchase',name:'Synthetic item',start:'2090-01-12',end:'2090-01-12',budget:9000,note:'',rowIds:['synthetic-book','synthetic-refund'],season:false,referenceAmount:null,manualPayment:null}});
  state=changeState(report,state,{action:'collection',revision:0,collection:{id:'trip',kind:'trip',name:'Synthetic trip',start:'2090-01-10',end:'2090-01-20',budget:12000,note:'',rowIds:['synthetic-book','synthetic-refund'],season:false,referenceAmount:null,manualPayment:null}});
  expect(summary(report,state,'2090').net).toBe(11800);
  expect(collectionTotals(state.collections[0],effectiveRows(report,state))).toEqual({paid:10000,recovered:3000,net:7000,count:2});
  expect(()=>changeState(report,state,{action:'collection',revision:0,collection:{...state.collections[1],id:'other-trip'}})).toThrow('LINK_ALREADY_ASSIGNED');
 });
 it('changes only a selected category and its linked recovery, with immutable originals',()=>{
  const report=fixture(),before=structuredClone(report);const state=changeState(report,initialState(report),{action:'row',revision:0,id:'synthetic-book',category:'Equipment',note:'Synthetic note',excluded:false});
  expect(summary(report,state,'2090').categories.find(c=>c.category==='Equipment')?.actual).toBe(7000);
  expect(summary(report,state,'2090').net).toBe(11800);expect(report).toEqual(before);
  const excluded=changeState(report,state,{action:'row',revision:1,id:'synthetic-book',category:'Equipment',note:'Own transfer',excluded:true});
  expect(summary(report,excluded,'2090').net).toBe(4800);
 });
 it('versions budget limits without changing prior months or capital',()=>{
  const report=fixture(),state=changeState(report,initialState(report),{action:'budget',revision:0,from:'2090-02',category:'Books',amount:11000});
  expect(summary(report,state,'2090-01').plan).toBe(13000);expect(summary(report,state,'2090-02').plan).toBe(18000);
  expect(summary(report,state,'2090').plan).toBe(31000);expect(summary(report,state,'2090').net).toBe(11800);
 });
 it('rejects non-calendar filters, duplicate amounts and fabricated links',()=>{
  const report=fixture(),state=initialState(report);
  expect(()=>summary(report,state,'2090-13')).toThrow('PERIOD_INVALID');
  expect(()=>summary(report,state,'2091')).toThrow('PERIOD_UNAVAILABLE');
  expect(()=>changeState(report,state,{action:'row',revision:0,id:'missing',category:'Food',note:'',excluded:false})).toThrow('ROW_NOT_FOUND');
 });
 it('includes an explicit manual payment once and refuses a second bank debit for it',()=>{
  const report=fixture(),collection={id:'manual-item',kind:'purchase' as const,name:'Synthetic manual item',start:'2090-03-03',end:'2090-03-03',budget:null,note:'',rowIds:[],season:false,referenceAmount:null,manualPayment:{date:'2090-03-03',eur:7300}};
  const state=changeState(report,initialState(report),{action:'collection',revision:0,collection});
  const month=summary(report,state,'2090-03');expect(month.net).toBe(7300);expect(month.manualOnly).toBe(true);expect(month.fx).toBeNull();
  expect(collectionTotals(collection,effectiveRows(report,state)).net).toBe(7300);
  expect(()=>changeState(report,state,{action:'collection',revision:1,collection:{...collection,rowIds:['synthetic-book']}})).toThrow('MANUAL_PAYMENT_WITH_BANK_DEBIT');
  const linked=changeState(report,state,{action:'collection',revision:1,collection:{...collection,manualPayment:null,rowIds:['synthetic-book']}});
  expect(summary(report,linked,'2090').net).toBe(11800);
 });
 it('compares the same partial-month dates and does not compare an incomplete prior year',()=>{
  const report=fixture(),state=initialState(report);
  const comparison=comparisonFor(report,state,'2090-02','2090-02-08');expect(comparison?.from).toBe('2090-01-01');expect(comparison?.to).toBe('2090-01-08');
  expect(comparisonFor(report,state,'2090-02','2090-02-28')?.to).toBe('2090-01-31');
  expect(comparisonFor(report,state,'2090','2090-02-28')).toBeNull();
 });
});

describe('encrypted workspace and protected HTTP',()=>{
 let directory:string,db:EncryptedDatabase,store:WorkspaceStore;
 beforeEach(async()=>{directory=await mkdtemp(join(tmpdir(),'moneywave-workspace-synthetic-'));db=await openEncryptedDatabase(join(directory,'test.db'),Buffer.alloc(32,81));await applyMigrations(db);store=new WorkspaceStore(db);await store.seed(fixture());});
 afterEach(async()=>{await db.close();await rm(directory,{recursive:true,force:true});});
 it('persists category and operation names across reopen and supports undo',async()=>{
  await store.mutate({action:'categoryName',revision:0,category:'Books',name:'Reading'});
  await store.mutate({action:'row',revision:1,id:'synthetic-book',category:'Books',name:'Named synthetic item',note:'Separate note',excluded:false});
  await db.close();db=await openEncryptedDatabase(join(directory,'test.db'),Buffer.alloc(32,81));store=new WorkspaceStore(db);
  expect((await store.read()).state.categoryNames.Books).toBe('Reading');
  expect((await store.read()).state.overrides['synthetic-book'].name).toBe('Named synthetic item');
  await store.mutate({action:'undo',revision:2});
  expect((await store.read()).state.overrides['synthetic-book']).toBeUndefined();
  expect((await store.read()).state.categoryNames.Books).toBe('Reading');
  expect((await store.read()).report).toEqual(fixture());
 });
 it('persists revisions, rejects stale writes, and restores the previous state',async()=>{
  const original=await store.read();await store.mutate({action:'budget',revision:0,from:'2090-02',category:'Food',amount:8000});
  await expect(store.mutate({action:'budget',revision:0,from:'2090-02',category:'Food',amount:9000})).rejects.toThrow('REVISION_CONFLICT');
  await db.close();db=await openEncryptedDatabase(join(directory,'test.db'),Buffer.alloc(32,81));store=new WorkspaceStore(db);
  expect((await store.read()).state.budgets[0].amount).toBe(8000);await store.mutate({action:'undo',revision:1});
  expect((await store.read()).state).toEqual(original.state);expect(await store.history()).toHaveLength(2);
  expect((await db.get<{n:number}>('SELECT count(*) AS n FROM ledger_entries'))?.n).toBe(0);
  expect((await readFile(join(directory,'test.db'))).includes(Buffer.from('SYNTHETIC purchase'))).toBe(false);
 });
 it('serializes concurrent changes and allows one winner for a revision',async()=>{
  const outcomes=await Promise.allSettled([8000,9000].map(amount=>store.mutate({action:'budget',revision:0,from:'2090-02',category:'Food',amount})));
  expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect((await store.read()).revision).toBe(1);
 });
 it('accepts a future purchase plan but rejects recording it as an already-paid expense',async()=>{
  const datedStore=new WorkspaceStore(db,()=>new Date('2090-03-01'));
  const collection={id:'future-synthetic',kind:'purchase' as const,name:'SYNTHETIC future item',start:'2090-03-02',end:'2090-03-02',budget:4000,note:'',rowIds:[],season:false,referenceAmount:null,manualPayment:{date:'2090-03-02',eur:4000}};
  await expect(datedStore.mutate({action:'collection',revision:0,collection})).rejects.toThrow('FUTURE_MANUAL_PAYMENT');
  await datedStore.mutate({action:'collection',revision:0,collection:{...collection,manualPayment:null}});
  expect(summary((await datedStore.read()).report,(await datedStore.read()).state,'2090').net).toBe(11800);
 });
 it('refreshes an explicit report without discarding user edits or old source snapshots',async()=>{
  await store.mutate({action:'row',revision:0,id:'synthetic-book',category:'Equipment',note:'Synthetic correction',excluded:false});
  const replacement=fixture();replacement.coverage.generatedAt='2090-03-02';
  await expect(store.seed(replacement)).rejects.toThrow('WORKSPACE_ALREADY_INITIALIZED');
  await store.seed(replacement,true);expect((await store.read()).state.overrides['synthetic-book'].category).toBe('Equipment');
  expect((await db.get<{n:number}>('SELECT count(*) AS n FROM workspace_reports'))?.n).toBe(2);
  const invalid=fixture();invalid.rows=[];invalid.months=[];
  await expect(store.seed(invalid,true)).rejects.toThrow('REFRESH_WOULD_ORPHAN_EDITS');
 });
 it('checks Host, Origin, session, CSRF and size; uses the last stock date for a year',async()=>{
  let asOf='';const server=createWorkspaceServer({store,sourceCurrent:true,staticDirectory:resolve('src/web'),centers:{capital:async date=>{asOf=date??'';return {asOf,currency:'EUR',positions:[],knownAssetsMinor:'0',knownLiabilitiesMinor:'0',knownNetMinor:'0',completeNetWorthMinor:null,unvaluedCount:0,carriedForwardCount:0};},capitalHistory:async()=>[]}});
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const address=server.address();if(!address||typeof address==='string')throw new Error('NO_ADDRESS');const origin=`http://127.0.0.1:${address.port}`;
  try{
   expect((await fetch(origin+'/api/workspace')).status).toBe(401);
   expect((await fetch(origin+'/api/annual-comparison?mode=calendar&year=2090')).status).toBe(401);
   const badHost = await new Promise<number|undefined>(done=>get(origin,{headers:{Host:'evil.invalid'}},response=>{response.resume();done(response.statusCode);}));
   expect(badHost).toBe(403);
   expect((await fetch(origin,{headers:{Origin:'https://evil.invalid'}})).status).toBe(403);
   const landing=await fetch(origin);const cookie=landing.headers.get('set-cookie')!.split(';')[0];expect(landing.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
   const data=await (await fetch(origin+'/api/workspace',{headers:{Cookie:cookie}})).json();
   const yearComparison=await(await fetch(origin+'/api/annual-comparison?mode=calendar&year=2090',{headers:{Cookie:cookie}})).json();
   expect(yearComparison.current.net).toBe(11800);expect(yearComparison.previous.net).toBeNull();expect(yearComparison.delta).toBeNull();
   expect((await fetch(origin+'/api/annual-comparison?mode=trailing&asOf=2090-02-30',{headers:{Cookie:cookie}})).status).toBe(400);
   const change={action:'budget',revision:0,from:'2090-02',category:'Food',amount:8100};
   expect((await fetch(origin+'/api/change',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json',Origin:origin},body:JSON.stringify(change)})).status).toBe(403);
   const headers={Cookie:cookie,'Content-Type':'application/json',Origin:origin,'X-Moneywave-Csrf':data.csrf};
   expect((await fetch(origin+'/api/change',{method:'POST',headers,body:JSON.stringify(change)})).status).toBe(200);
   expect((await fetch(origin+'/api/change',{method:'POST',headers,body:' '.repeat(128001)})).status).toBe(400);
   const annual=await(await fetch(origin+'/api/period?period=2090',{headers:{Cookie:cookie}})).json();expect(annual.net).toBe(11800);expect(annual.capital.asOf).toBe('2090-02-28');
   expect((await fetch(origin+'/data/runtime/test.db',{headers:{Cookie:cookie}})).status).toBe(404);
  }finally{await new Promise<void>(done=>server.close(()=>done()));}
 });
 it('uses foreign personal accounts and cash for both capital and chart without changing all-bank reporting',async()=>{
  await db.run("INSERT OR IGNORE INTO providers (id,code,display_name) VALUES ('wise','wise','Synthetic foreign bank')");
  await db.run("INSERT OR IGNORE INTO providers (id,code,display_name) VALUES ('monobank','monobank','Synthetic operating bank')");
  await db.run("INSERT OR IGNORE INTO providers (id,code,display_name) VALUES ('privatbank','privatbank','Synthetic second operating bank')");
  await db.run("INSERT INTO providers (id,code,display_name) VALUES ('synthetic-cash','synthetic-cash','Synthetic cash')");
  const accounts=[['foreign','wise','card','PERSONAL',10000],['foreign-debt','wise','card','PERSONAL',-1000],['operating','monobank','card','PERSONAL',20000],['operating-debt','privatbank','card','PERSONAL',-5000],['business','wise','business','SOLE_PROPRIETOR',30000],['cash','synthetic-cash','cash','PERSONAL',2000]] as const;
  for(const [id,provider,type,scope,amount] of accounts){
   await db.run('INSERT INTO accounts (id,provider_id,owner_scope,account_type,currency,display_name) VALUES (?,?,?,?,?,?)',[id,provider,scope,type,'EUR',`SYNTHETIC ${id}`]);
   if(type==='cash')await db.run("INSERT INTO cash_opening_balances (account_id,opening_date,balance_minor,currency,evidence_kind) VALUES (?,'2090-01-01',?,'EUR','user_asserted')",[id,amount]);
   else for(const day of ['2090-01-31','2090-02-28'])await db.run("INSERT INTO balance_snapshots (id,account_id,balance_minor,currency,observed_at,evidence_kind) VALUES (?,?,?,'EUR',?,'statement')",[`${id}-${day}`,id,amount,day]);
  }
  await db.run("INSERT INTO accounts (id,provider_id,owner_scope,account_type,currency,display_name) VALUES ('foreign-missing','wise','PERSONAL','card','USD','SYNTHETIC unknown balance')");
  const centers=new FinanceCenters(db,()=>new Date('2090-03-01'));
  const original=await centers.capital('2090-02-28','EUR');
  expect(original.knownNetMinor).toBe('56000');
  const server=createWorkspaceServer({store,sourceCurrent:true,staticDirectory:resolve('src/web'),centers});
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const address=server.address();if(!address||typeof address==='string')throw new Error('NO_ADDRESS');const origin=`http://127.0.0.1:${address.port}`;
  try{
   const landing=await fetch(origin),Cookie=landing.headers.get('set-cookie')!.split(';')[0];
   const annual=await(await fetch(origin+'/api/period?period=2090',{headers:{Cookie}})).json();
   expect(annual.capital).toMatchObject({knownAssetsMinor:'12000',knownLiabilitiesMinor:'1000',knownNetMinor:'11000',unvaluedCount:1,completeNetWorthMinor:null});
   expect(annual.capital.positions.map((p:{id:string})=>p.id).sort()).toEqual(['cash','foreign','foreign-debt','foreign-missing']);
   expect(annual.net).toBe(11800);expect(annual.income).toBe(100000);expect(annual.tax).toBe(1000);expect(annual.bank).toBe(40);
   const history=await(await fetch(origin+'/api/capital-history',{headers:{Cookie}})).json();
   expect(history).toHaveLength(2);
   for(const point of history){
    const month=await(await fetch(origin+`/api/period?period=${point.asOf.slice(0,7)}`,{headers:{Cookie}})).json();
    expect(point).toMatchObject({knownMinor:'11000',valuedCount:3,missingCount:1});
    expect(point.knownMinor).toBe(month.capital.knownNetMinor);
   }
   expect(await centers.capital('2090-02-28','EUR')).toEqual(original);
  }finally{await new Promise<void>(done=>server.close(()=>done()));}
 });
});

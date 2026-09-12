import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {openEncryptedDatabase,type EncryptedDatabase} from '@/server/db/database';
import {applyMigrations} from '@/server/db/migrations';
import {WorkspaceStore,ledgerFingerprint} from '@/server/workspace/store';
import {effectiveRows,reportSchema,summary} from '@/server/workspace/model';
import {FinanceCenters} from '@/server/read-model/finance-centers';
import {createWorkspaceServer} from '@/server/workspace/http';

const now=()=>new Date('2090-03-12T12:00:00Z');
const fixture=()=>reportSchema.parse({version:2,coverage:{start:'2090-01-01',end:'2090-01-31',generatedAt:'2090-02-01'},ledgerDigest:'synthetic',sources:[],collections:[],plan:{'Кава':3000},rows:[],months:[{month:'2090-01',income:50000,tax:0,bank:0,netSpending:0,grossSpending:0,partial:false}]});
const expense={id:'synthetic-cash-expense',accountId:'synthetic-cash-eur',date:'2090-01-12',amountMinor:450,category:'Кава',description:'SYNTHETIC coffee'};
const create=(overrides={})=>({action:'cashExpense',revision:0,mode:'create',expense:{...expense,...overrides}});

describe('daily cash expenses (synthetic only)',()=>{
 let root:string,db:EncryptedDatabase,store:WorkspaceStore,centers:FinanceCenters;
 beforeEach(async()=>{
  root=await mkdtemp(join(tmpdir(),'moneywave-cash-expense-'));db=await openEncryptedDatabase(join(root,'test.db'),Buffer.alloc(32,84));await applyMigrations(db);
  await db.run("INSERT INTO providers(id,code,display_name) VALUES('synthetic-provider','cash','SYNTHETIC cash')");
  for(const currency of ['EUR','USD','UAH']){
   const id='synthetic-cash-'+currency.toLowerCase();
   await db.run("INSERT INTO accounts(id,provider_id,owner_scope,account_type,currency,display_name) VALUES(?,'synthetic-provider','PERSONAL','cash',?,?)",[id,currency,'SYNTHETIC '+currency]);
   await db.run("INSERT INTO cash_opening_balances(account_id,opening_date,balance_minor,currency,evidence_kind) VALUES(?,'2090-01-01',10000,?,'user_asserted')",[id,currency]);
  }
  store=new WorkspaceStore(db,now);centers=new FinanceCenters(db,now);await store.seed(fixture());
 });
 afterEach(async()=>{await db.close();await rm(root,{recursive:true,force:true});});
 it('persists a standalone expense once in its month, category and cash balance, preserving bank evidence',async()=>{
  const fingerprint=await ledgerFingerprint(db);await store.mutate(create());
  await db.close();db=await openEncryptedDatabase(join(root,'test.db'),Buffer.alloc(32,84));store=new WorkspaceStore(db,now);centers=new FinanceCenters(db,now);
  const w=await store.read(),rows=effectiveRows(w.report,w.state),view=summary(w.report,w.state,'2090-01');
  expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({id:'cash:'+expense.id,eur:450,currency:'EUR',nativeMinor:'-450',group:'Кава',source:'manual_cash_expense'});
  expect(view.net).toBe(450);expect(view.categories.find(c=>c.category==='Кава')?.actual).toBe(450);
  expect((await centers.capital('2090-01-11','EUR',undefined,w.state.cashExpenses)).positions.find(p=>p.id===expense.accountId)?.nativeMinor).toBe('10000');
  expect((await centers.capital('2090-01-12','EUR',undefined,w.state.cashExpenses)).positions.find(p=>p.id===expense.accountId)?.nativeMinor).toBe('9550');
  expect(await ledgerFingerprint(db)).toBe(fingerprint);expect(w.report).toEqual(fixture());
 });
 it('edits, deletes and undoes using revisions, and retains entries across report refresh',async()=>{
  await store.mutate(create());
  await store.mutate({action:'cashExpense',mode:'update',revision:1,expense:{...expense,amountMinor:600,date:'2090-02-03',category:'Їжа'}});
  let w=await store.read();expect(summary(w.report,w.state,'2090-01').net).toBe(0);expect(summary(w.report,w.state,'2090-02')).toMatchObject({net:600,manualOnly:true});
  const report=fixture();report.coverage.generatedAt='2090-03-01';await store.seed(report,true);
  w=await store.read();expect(w.state.cashExpenses).toHaveLength(1);expect(w.state.cashExpenses[0].amountMinor).toBe(600);
  await store.mutate({action:'deleteCashExpense',revision:w.revision,id:expense.id});w=await store.read();expect(w.state.cashExpenses).toEqual([]);
  await store.mutate({action:'undo',revision:w.revision});w=await store.read();expect(w.state.cashExpenses[0].amountMinor).toBe(600);
  expect((await centers.capital('2090-03-12','EUR',undefined,w.state.cashExpenses)).positions.find(p=>p.id===expense.accountId)?.nativeMinor).toBe('9400');
 });
 it('values native currency with cached official evidence available on the expense date',async()=>{
  await db.run("INSERT INTO fx_rate_cache(base_currency,quote_currency,requested_date,rate_text,source,publication_date) VALUES('USD','EUR','2090-01-10','0.8','ECB','2090-01-10'),('USD','EUR','2090-01-13','0.9','ECB','2090-01-13')");
  await store.mutate(create({accountId:'synthetic-cash-usd',amountMinor:1001}));const w=await store.read();
  expect(w.state.cashExpenses[0]).toMatchObject({currency:'USD',amountMinor:1001,eur:801,rate:'0.8',rateSource:'ECB',publicationDate:'2090-01-10'});
  expect(summary(w.report,w.state,'2090-01').net).toBe(801);
  expect((await centers.capital('2090-01-12','EUR',undefined,w.state.cashExpenses)).positions.find(p=>p.currency==='USD')?.nativeMinor).toBe('8999');
  await store.mutate({action:'cashExpense',mode:'update',revision:1,expense:{...expense,accountId:'synthetic-cash-usd',amountMinor:1001,description:'SYNTHETIC renamed'}});
  expect((await store.read()).state.cashExpenses[0].eur).toBe(801);
 });
 it('rejects missing rates, non-cash accounts, future dates and conflicting create/update requests atomically',async()=>{
  await expect(store.mutate(create({accountId:'synthetic-cash-usd'}))).rejects.toThrow('CASH_RATE_UNAVAILABLE');
  await expect(store.mutate(create({accountId:'missing'}))).rejects.toThrow('CASH_ACCOUNT_INVALID');
  await expect(store.mutate(create({date:'2090-03-13'}))).rejects.toThrow('FUTURE_CASH_EXPENSE');
  expect(()=>store.mutate(create({amountMinor:0}))).toThrow();expect(()=>store.mutate(create({amountMinor:1.5}))).toThrow();
  expect(()=>store.mutate(create({date:'2090-02-30'}))).toThrow();
  await expect(store.mutate({...create(),mode:'update'})).rejects.toThrow('CASH_EXPENSE_NOT_FOUND');
  expect((await store.read()).revision).toBe(0);
  await store.mutate(create());
  await expect(store.mutate({...create(),revision:1})).rejects.toThrow('CASH_EXPENSE_EXISTS');
  await expect(store.mutate({...create(),mode:'update'})).rejects.toThrow('REVISION_CONFLICT');
  expect((await store.read()).state.cashExpenses).toHaveLength(1);
 });
 it('keeps a negative calculated cash amount as a conflict instead of debt',async()=>{
  await store.mutate(create({amountMinor:10001}));const w=await store.read();
  const capital=await centers.capital('2090-01-31','EUR',undefined,w.state.cashExpenses);
  expect(capital.positions.find(p=>p.id===expense.accountId)).toMatchObject({nativeMinor:'-1',status:'conflict',reportMinor:null});expect(capital.knownLiabilitiesMinor).toBe('0');
 });
 it('does not subtract old expenses twice from a later observed cash balance',async()=>{
  await db.run("INSERT INTO manual_workbooks(id,contract_version) VALUES('synthetic-workbook','1')");
  await db.run("INSERT INTO manual_position_series(id,lineage_id,label_key,display_name,provider_code,position_kind,currency,account_id) VALUES('synthetic-series','synthetic-workbook',?,'SYNTHETIC cash','cash','cash','EUR','synthetic-cash-eur')",['s'.repeat(64)]);
  await db.run("INSERT INTO manual_position_facts(id,series_id,period,amount_minor) VALUES('synthetic-fact','synthetic-series','2090-01',7000)");
  await store.mutate(create());await store.mutate({...create({id:'synthetic-after',date:'2090-02-05',amountMinor:300}),revision:1});const w=await store.read();
  expect((await centers.capital('2090-01-31','EUR',undefined,w.state.cashExpenses)).positions.find(p=>p.currency==='EUR')).toMatchObject({nativeMinor:'7000',manualEvidence:{differenceMinor:'-2550'}});
  expect((await centers.capital('2090-02-28','EUR',undefined,w.state.cashExpenses)).positions.find(p=>p.currency==='EUR')?.nativeMinor).toBe('6700');
  expect(summary(w.report,w.state,'2090').net).toBe(750);
 });
 it('retains cash facts when an older reader writes an overlay without the new field',async()=>{
  await store.mutate(create());const current=await store.read();
  const legacy=structuredClone(current.state) as Record<string,unknown>;delete legacy.cashExpenses;
  await db.run("INSERT INTO workspace_history(revision,action,before_json,after_json) VALUES(2,'budget',?,?)",[JSON.stringify(legacy),JSON.stringify(legacy)]);
  await db.run('UPDATE workspace_state SET revision=2,payload_json=? WHERE id=1',[JSON.stringify(legacy)]);
  expect((await store.read()).state.cashExpenses).toHaveLength(1);
  await store.mutate({action:'undo',revision:2});expect((await store.read()).state.cashExpenses).toHaveLength(1);
 });
 it('honors an older reader undoing the immediately preceding cash action',async()=>{
  await store.mutate(create());const current=await store.read();
  const legacy=structuredClone(current.state) as Record<string,unknown>;delete legacy.cashExpenses;
  await db.run("INSERT INTO workspace_history(revision,action,before_json,after_json) VALUES(2,'undo',?,?)",[JSON.stringify(legacy),JSON.stringify(legacy)]);
  await db.run('UPDATE workspace_state SET revision=2,payload_json=? WHERE id=1',[JSON.stringify(legacy)]);
  expect((await store.read()).state.cashExpenses).toEqual([]);
 });
 it('serves cash accounts and changes totals over the protected HTTP path, denying unauthenticated writes',async()=>{
  const server=createWorkspaceServer({store,centers,now,staticDirectory:resolve('src/web'),sourceCurrent:true});await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const address=server.address();if(!address||typeof address==='string')throw new Error('NO_ADDRESS');const origin=`http://127.0.0.1:${address.port}`;
  try{
   const landing=await fetch(origin),cookie=landing.headers.get('set-cookie')!.split(';')[0],headers={Cookie:cookie};
   const w=await(await fetch(origin+'/api/workspace',{headers})).json();expect(w.cashAccounts.map((a:{currency:string})=>a.currency).sort()).toEqual(['EUR','UAH','USD']);expect(w.cashHistory).toEqual([]);
   const denied=await fetch(origin+'/api/change',{method:'POST',headers:{...headers,Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(create())});expect(denied.status).toBe(403);
   const saved=await fetch(origin+'/api/change',{method:'POST',headers:{...headers,Origin:origin,'Content-Type':'application/json','X-Moneywave-Csrf':w.csrf},body:JSON.stringify(create())});expect(saved.status).toBe(200);
   const period=await(await fetch(origin+'/api/period?period=2090-01',{headers})).json();expect(period.net).toBe(450);expect(period.capital.positions.find((p:{id:string})=>p.id===expense.accountId).nativeMinor).toBe('9550');
   const history=await(await fetch(origin+'/api/capital-history',{headers})).json();expect(history[0].knownMinor).toBe('9550');
  }finally{await new Promise<void>(done=>server.close(()=>done()));}
 });
});

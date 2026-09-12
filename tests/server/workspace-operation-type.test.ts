import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {openEncryptedDatabase,type EncryptedDatabase} from '@/server/db/database';
import {applyMigrations} from '@/server/db/migrations';
import {WorkspaceStore,ledgerFingerprint} from '@/server/workspace/store';
import {effectiveRows,reportSchema,summary} from '@/server/workspace/model';
import {saveWorkspaceCategoryRules} from '@/server/workspace/processing-rules';
import {createWorkspaceServer} from '@/server/workspace/http';
import {FinanceCenters} from '@/server/read-model/finance-centers';

const fixture=()=>reportSchema.parse({version:2,coverage:{start:'2090-01-01',end:'2090-01-31',generatedAt:'2090-02-01'},ledgerDigest:'synthetic',sources:[],collections:[],plan:{'Подарунки':20000},
 rows:[{id:'synthetic-debit',date:'2090-01-12',eur:12000,group:'Подарунки',description:'SYNTHETIC payment',provider:'SYNTHETIC bank',source:'synthetic'},
 {id:'synthetic-refund',date:'2090-01-13',eur:-1000,group:'Подарунки',description:'SYNTHETIC refund',provider:'SYNTHETIC bank',source:'synthetic',purchaseId:'synthetic-debit'}],
 months:[{month:'2090-01',income:50000,tax:0,bank:0,netSpending:11000,grossSpending:11000,partial:false}]});
const correction={action:'row',revision:0,id:'synthetic-debit',category:'Подарунки',name:'SYNTHETIC payment',note:'',excluded:true,operationType:'cash_fx'};

describe('explicit cash currency purchase correction',()=>{
 let root:string,db:EncryptedDatabase,store:WorkspaceStore;
 beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),'moneywave-operation-synthetic-'));db=await openEncryptedDatabase(join(root,'test.db'),Buffer.alloc(32,83));await applyMigrations(db);store=new WorkspaceStore(db);await store.seed(fixture());});
 afterEach(async()=>{await db.close();await rm(root,{recursive:true,force:true});});
 it('persists the type, excludes spending and supports undo without inventing cash or changing sources',async()=>{
  const fingerprint=await ledgerFingerprint(db);
  await store.mutate(correction);
  await db.close();db=await openEncryptedDatabase(join(root,'test.db'),Buffer.alloc(32,83));store=new WorkspaceStore(db);
  let w=await store.read();
  expect(w.state.overrides['synthetic-debit']).toMatchObject({operationType:'cash_fx',excluded:true,category:'Подарунки'});
  expect(effectiveRows(w.report,w.state)[0]).toMatchObject({operationType:'cash_fx',excluded:true});
  expect(effectiveRows(w.report,w.state)[1]).toMatchObject({operationType:'excluded',excluded:true});
  expect(summary(w.report,w.state,'2090-01').net).toBe(0);
  expect(summary(w.report,w.state,'2090-01').categories[0]).toMatchObject({actual:0,plan:20000});
  expect(await ledgerFingerprint(db)).toBe(fingerprint);
  expect(w.report).toEqual(fixture());
  await store.mutate({action:'undo',revision:w.revision});w=await store.read();
  expect(summary(w.report,w.state,'2090-01').net).toBe(11000);
  expect(effectiveRows(w.report,w.state)[0]).toMatchObject({operationType:'expense',excluded:false});
 });
 it('preserves type on legacy name edits and explicit report refresh, and permits switching back to spending',async()=>{
  await store.mutate(correction);
  await store.mutate({...correction,revision:1,operationType:undefined,name:'SYNTHETIC renamed'});
  const replacement=fixture();replacement.coverage.generatedAt='2090-02-02';await store.seed(replacement,true);
  let w=await store.read();expect(w.state.overrides['synthetic-debit']).toMatchObject({operationType:'cash_fx',name:'SYNTHETIC renamed'});
  await store.mutate({...correction,revision:w.revision,operationType:'expense',excluded:false});w=await store.read();
  expect(effectiveRows(w.report,w.state)[0]).toMatchObject({operationType:'expense',excluded:false});
  expect(summary(w.report,w.state,'2090-01').net).toBe(11000);
 });
 it('rejects contradictory types and refuses to label a refund as cash purchased',async()=>{
  expect(()=>store.mutate({...correction,excluded:false})).toThrow('OPERATION_TYPE_CONFLICT');
  expect(()=>store.mutate({...correction,operationType:'expense'})).toThrow('OPERATION_TYPE_CONFLICT');
  await expect(store.mutate({...correction,id:'synthetic-refund'})).rejects.toThrow('CASH_FX_REQUIRES_DEBIT');
  expect((await store.read()).revision).toBe(0);
 });
 it('recognizes existing exact currency exclusions without treating every exclusion as currency',async()=>{
  await store.mutate({...correction,operationType:undefined,category:'Купівля валюти'});
  let w=await store.read();expect(effectiveRows(w.report,w.state)[0]).toMatchObject({operationType:'fx',excluded:true});
  await store.mutate({...correction,revision:1,operationType:undefined,category:'Подарунки'});
  w=await store.read();expect(effectiveRows(w.report,w.state)[0]).toMatchObject({operationType:'excluded',excluded:true});
 });
 it('saves a typed cash purchase as an exact confirmed FX rule independently of the old expense category',async()=>{
  await db.run("INSERT INTO providers(id,code,display_name) VALUES('synthetic-provider','synthetic','Synthetic')");
  await db.run("INSERT INTO accounts(id,provider_id,owner_scope,account_type,currency,display_name) VALUES('synthetic-account','synthetic-provider','PERSONAL','card','EUR','Synthetic')");
  await db.run("INSERT INTO ledger_entries(id,account_id,amount_minor,currency,direction,occurred_at,entry_kind) VALUES('synthetic-debit','synthetic-account',-12000,'EUR','debit','2090-01-12','terminal_personal_expense')");
  await store.mutate(correction);expect((await saveWorkspaceCategoryRules(db)).selected).toBe(1);
  const rules=await db.all<{match:string;code:string}>('SELECT r.match_json AS match,c.code FROM categorization_rules r JOIN categories c ON c.id=r.category_id');
  expect(rules.map(r=>({...JSON.parse(r.match),categoryCode:r.code}))).toEqual(expect.arrayContaining([expect.objectContaining({confirmedFx:true,categoryCode:'transfers'})]));
  expect((await db.get<{n:number}>('SELECT count(*) AS n FROM movement_legs'))?.n).toBe(0);
 });
 it('round trips the type through protected HTTP and returns it after reload',async()=>{
  const server=createWorkspaceServer({store,centers:new FinanceCenters(db),staticDirectory:resolve('src/web'),sourceCurrent:true});
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const address=server.address();if(!address||typeof address==='string')throw new Error('NO_ADDRESS');const origin=`http://127.0.0.1:${address.port}`;
  try{
   const landing=await fetch(origin),cookie=landing.headers.get('set-cookie')!.split(';')[0];
   const initial=await(await fetch(origin+'/api/workspace',{headers:{Cookie:cookie}})).json();
   const saved=await fetch(origin+'/api/change',{method:'POST',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json','X-Moneywave-Csrf':initial.csrf},body:JSON.stringify(correction)});
   expect(saved.status).toBe(200);
   const result=await(await fetch(origin+'/api/workspace',{headers:{Cookie:cookie}})).json();
   expect(result.rows[0]).toMatchObject({operationType:'cash_fx',excluded:true});
  }finally{await new Promise<void>(done=>server.close(()=>done()));}
 });
});

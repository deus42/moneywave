import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openEncryptedDatabase,type EncryptedDatabase} from '@/server/db/database';
import {applyMigrations} from '@/server/db/migrations';
import {HEALTH_BEAUTY_GROUP,FORMER_HOME_GROUP,PURCHASES_KEY,PURCHASES_NAME,CATEGORY_POLICY_VERSION,policyCategoryCode} from '@/domain/category-policy';
import {normalizeReportCategories,normalizeWorkspaceCategories} from '@/server/workspace/category-policy';
import {budgetFor,initialState,reportSchema,collectionSchema} from '@/server/workspace/model';
import {WorkspaceStore} from '@/server/workspace/store';
import {saveWorkspaceMerchantAliases} from '@/server/workspace/processing-rules';
import {CategoryPolicyService} from '@/server/categorization/category-policy-service';
import {AutonomousCategorizationService} from '@/server/categorization/autonomous-service';

const report=()=>reportSchema.parse({version:1,coverage:{start:'2090-01-01',end:'2090-01-31',generatedAt:'2090-02-01'},ledgerDigest:'synthetic',sources:[],collections:[],
 rows:[{id:'synthetic-old',date:'2090-01-15',group:FORMER_HOME_GROUP,description:'SYNTHETIC ORBIT SHOP',eur:1000,provider:'SYNTHETIC',source:'synthetic'}],
 months:[{month:'2090-01',income:10000,tax:0,bank:0,netSpending:1000,grossSpending:1000,partial:false}],plan:{[FORMER_HOME_GROUP]:100,[PURCHASES_KEY]:200}});

describe('home and purchases consolidation',()=>{
 it('separates retained health sources and refunds while preserving household purchases and existing limits',()=>{
  const raw=report();raw.plan={[PURCHASES_KEY]:900};
  raw.rows=[
   {...raw.rows[0],id:'synthetic-care',group:PURCHASES_KEY,originalCategory:'Особистий догляд'},
   {...raw.rows[0],id:'synthetic-medical',group:PURCHASES_KEY,originalCategory:'Медицина та аптеки'},
   {...raw.rows[0],id:'synthetic-home',group:PURCHASES_KEY,originalCategory:'Дім'},
   {...raw.rows[0],id:'synthetic-mueller',group:PURCHASES_KEY,originalCategory:'Особистий догляд',description:'SYNTHETIC MÜLLER'},
   {...raw.rows[0],id:'synthetic-refund',group:PURCHASES_KEY,purchaseId:'synthetic-care',eur:-300},
  ];
  const state=initialState(raw);state.budgets=[{category:PURCHASES_KEY,from:'2090-01',amount:1500}];
  const next=normalizeReportCategories(raw);
  expect(next.rows.map(r=>r.group)).toEqual([HEALTH_BEAUTY_GROUP,HEALTH_BEAUTY_GROUP,PURCHASES_KEY,PURCHASES_KEY,HEALTH_BEAUTY_GROUP]);
  expect(next.rows[0].categoryPolicy).toEqual({version:CATEGORY_POLICY_VERSION,rule:'source-health-beauty'});
  expect(next.rows.map(r=>r.eur)).toEqual(raw.rows.map(r=>r.eur));
  expect(next.plan).toEqual(raw.plan);
  expect(normalizeWorkspaceCategories(raw,state).budgets).toEqual(state.budgets);
  expect(budgetFor(next,state,HEALTH_BEAUTY_GROUP,'2090-01')).toBe(0);
  expect(normalizeReportCategories(next)).toEqual(next);
 });
 it('sums both live category limits at every effective month and remains stable on another refresh',()=>{
  const raw=report(),state=initialState(raw);
  state.budgets=[{category:PURCHASES_KEY,from:'2089-01',amount:500},{category:FORMER_HOME_GROUP,from:'2090-01',amount:300},{category:PURCHASES_KEY,from:'2090-02',amount:700}];
  state.overrides['synthetic-old']={category:FORMER_HOME_GROUP,note:'SYNTHETIC note',excluded:false};
  state.categoryNames={[FORMER_HOME_GROUP]:'SYNTHETIC former label',[PURCHASES_KEY]:PURCHASES_NAME};
  const merged=normalizeReportCategories(raw),next=normalizeWorkspaceCategories(raw,state);
  expect(merged.plan).toEqual({[PURCHASES_KEY]:300});
  expect(['2089-01','2090-01','2090-02'].map(month=>budgetFor(merged,next,PURCHASES_KEY,month))).toEqual([600,800,1000]);
  expect(next.overrides['synthetic-old']).toEqual({...state.overrides['synthetic-old'],category:PURCHASES_KEY});
  expect(next.categoryNames).toEqual({[PURCHASES_KEY]:PURCHASES_NAME});
  expect(normalizeWorkspaceCategories(merged,next)).toEqual(next);
  expect(normalizeReportCategories(merged)).toEqual(merged);
  expect(['home','health','pharmacy','medical','personal_care','electronics','clothing'].map(policyCategoryCode)).toEqual(['shopping','health','health','health','health','shopping','shopping']);
 });
});

describe('encrypted store decisions for future imports',()=>{
 let root:string,db:EncryptedDatabase;
 beforeEach(async()=>{
  root=await mkdtemp(join(tmpdir(),'moneywave-merge-synthetic-'));db=await openEncryptedDatabase(join(root,'test.db'),Buffer.alloc(32,77));await applyMigrations(db);
  await db.run("INSERT INTO providers(id,code,display_name) VALUES('synthetic-provider','synthetic','SYNTHETIC')");
  await db.run("INSERT INTO accounts(id,provider_id,owner_scope,account_type,currency,display_name,identifier_hmac) VALUES('synthetic-account','synthetic-provider','PERSONAL','card','EUR','SYNTHETIC',?)",['b'.repeat(64)]);
 });
 afterEach(async()=>{await db.close();await rm(root,{recursive:true,force:true});});
 async function entry(id:string,description='SYNTHETIC ORBIT SHOP',kind='terminal_personal_expense'){
  await db.run("INSERT INTO ledger_entries(id,account_id,amount_minor,currency,direction,occurred_at,entry_kind,private_description) VALUES(?,'synthetic-account',-1000,'EUR','debit','2090-01-15',?,?)",[id,kind,description]);
 }
 it('preserves unchanged collections and their order during category-only report refresh',async()=>{
  const raw=report();raw.collections=['synthetic-first','synthetic-second'].map(id=>collectionSchema.parse({id,kind:'purchase',name:id,start:'2090-01-01',end:'2090-01-02',budget:null,rowIds:[]}));
  const store=new WorkspaceStore(db);await store.seed(raw);
  await store.mutate({action:'collection',revision:0,collection:{...raw.collections[1],note:'SYNTHETIC edited'}});
  const before=await store.read();raw.coverage.generatedAt='2090-02-02';await store.seed(raw,true);
  expect((await store.read()).state.collections).toEqual(before.state.collections);
 });
 it('remembers an exact merchant for a new import, with no AI call or broad name matching',async()=>{
  await entry('synthetic-old');await new WorkspaceStore(db).seed(report());
  expect(await saveWorkspaceMerchantAliases(db)).toEqual({saved:1,selected:1,ambiguous:0});
  expect(await saveWorkspaceMerchantAliases(db)).toEqual({saved:0,selected:1,ambiguous:0});
  await entry('synthetic-new','synthetic   orbit shop','unclassified');
  await entry('synthetic-movement','SYNTHETIC ORBIT SHOP','unlinked_transfer_out');
  const classifier={categorizeBatch:vi.fn(async()=>{throw new Error('NO_AI_EXPECTED');})};
  await new AutonomousCategorizationService(db,classifier).run();
  expect(classifier.categorizeBatch).not.toHaveBeenCalled();
  expect(await db.get(`SELECT c.code,a.method FROM category_assignments a JOIN categories c ON c.id=a.category_id WHERE a.ledger_entry_id='synthetic-new' ORDER BY a.rowid DESC LIMIT 1`)).toEqual({code:'shopping',method:'alias'});
  expect(await db.get("SELECT entry_kind AS kind FROM ledger_entries WHERE id='synthetic-movement'")).toEqual({kind:'unlinked_transfer_out'});
  expect(await db.get("SELECT id FROM category_aliases WHERE normalized_alias='synthetic orbit shop annex'")).toBeUndefined();
 });
 it('replaces an owned purchase alias with health and applies it to the next imported entry',async()=>{
  await entry('synthetic-old');const raw=report(),store=new WorkspaceStore(db);await store.seed(raw);
  await saveWorkspaceMerchantAliases(db);
  await db.run("UPDATE category_aliases SET id='confirmed-purchase-merchant:synthetic' WHERE provider_code='synthetic'");
  raw.rows[0].originalCategory='Медицина та аптеки';await store.seed(raw,true);
  expect(await saveWorkspaceMerchantAliases(db)).toEqual({saved:1,selected:1,ambiguous:0});
  expect((await saveWorkspaceMerchantAliases(db)).saved).toBe(0);
  await entry('synthetic-new','SYNTHETIC ORBIT SHOP','unclassified');
  const classifier={categorizeBatch:vi.fn(async()=>{throw new Error('NO_AI_EXPECTED');})};
  await new AutonomousCategorizationService(db,classifier).run();
  expect(classifier.categorizeBatch).not.toHaveBeenCalled();
  expect(await db.get(`SELECT c.code FROM category_assignments a JOIN categories c ON c.id=a.category_id WHERE a.ledger_entry_id='synthetic-new' ORDER BY a.rowid DESC LIMIT 1`)).toEqual({code:'health'});
 });
 it('disables an owned alias when the split reveals mixed categories and preserves independent aliases',async()=>{
  await entry('synthetic-old');const raw=report(),store=new WorkspaceStore(db);await store.seed(raw);await saveWorkspaceMerchantAliases(db);
  await entry('synthetic-other');raw.rows.push({...raw.rows[0],id:'synthetic-other',originalCategory:'Особистий догляд'});raw.months[0].grossSpending=2000;raw.months[0].netSpending=2000;await store.seed(raw,true);
  expect(await saveWorkspaceMerchantAliases(db)).toEqual({saved:1,selected:0,ambiguous:1});
  expect(await db.get("SELECT enabled FROM category_aliases WHERE provider_code='synthetic'")).toEqual({enabled:0});
  expect((await saveWorkspaceMerchantAliases(db)).saved).toBe(0);
  await db.run("UPDATE category_aliases SET id='synthetic-independent',enabled=1 WHERE provider_code='synthetic'");
  expect((await saveWorkspaceMerchantAliases(db)).saved).toBe(0);
  expect(await db.get("SELECT enabled FROM category_aliases WHERE id='synthetic-independent'")).toEqual({enabled:1});
 });
 it('skips descriptors that also belong to another category',async()=>{
  await entry('synthetic-old');await entry('synthetic-other');
  const raw=report();raw.rows.push({...raw.rows[0],id:'synthetic-other',group:'Продукти'});raw.months[0].grossSpending=2000;raw.months[0].netSpending=2000;
  await new WorkspaceStore(db).seed(raw);
  expect(await saveWorkspaceMerchantAliases(db)).toEqual({saved:0,selected:0,ambiguous:1});
 });
 it('upgrades prior policy assignments while preserving independent manual decisions',async()=>{
  await entry('synthetic-old');await entry('synthetic-manual');
  const home=await db.get<{id:string}>("SELECT id FROM categories WHERE code='home'");
  for(const [id,method] of [['synthetic-old','user_rule'],['synthetic-manual','manual']])await db.run("INSERT INTO category_assignments(id,ledger_entry_id,category_id,method,classification_version,needs_review) VALUES(?,?,?,?, 'personal-categories-2026-09-v1',0)",[id,id,home!.id,method]);
  expect(await new CategoryPolicyService(db).apply()).toMatchObject({assigned:1,manualPreserved:1});
  expect(await db.get(`SELECT c.code,a.classification_version AS version FROM category_assignments a JOIN categories c ON c.id=a.category_id WHERE a.ledger_entry_id='synthetic-old' ORDER BY a.rowid DESC LIMIT 1`)).toEqual({code:'shopping',version:CATEGORY_POLICY_VERSION});
  expect((await new CategoryPolicyService(db).apply()).assigned).toBe(0);
 });
});

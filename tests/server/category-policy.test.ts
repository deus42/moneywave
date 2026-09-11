import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openEncryptedDatabase,type EncryptedDatabase} from '@/server/db/database';
import {applyMigrations} from '@/server/db/migrations';
import {normalizeWorkspaceCategories} from '@/server/workspace/category-policy';
import {initialState} from '@/server/workspace/model';
import {saveWorkspaceCategoryRules} from '@/server/workspace/processing-rules';
import {CategoryPolicyService} from '@/server/categorization/category-policy-service';
import {ReclassificationPreparationService} from '@/server/categorization/reclassification-preparation';
import {EntryClassificationService} from '@/server/categorization/entry-classification';
import {WorkspaceStore} from '@/server/workspace/store';
import {effectiveRows,reportSchema,summary} from '@/server/workspace/model';
import {classifyPersonalEntry} from '@/domain/personal-categorization';

describe('confirmed personal category policy',()=>{
 it.each([
  ['SYNTHETIC Circle Coffee','Кафе та ресторани','5814','coffee'],
  ['SYNTHETIC COFFEE CIRCL','Покупки','5999','coffee'],
  ['SYNTHETIC MÜLLER','Краса та догляд','5977','home'],
  ['SYNTHETIC MUELLER','Покупки','5399','home'],
  ['SYNTHETIC shop','Здоров’я та добавки',null,'home'],
  ['SYNTHETIC taxi','Інший транспорт',null,'transport'],
  ['SYNTHETIC gym','Спорт',null,'travel'],
  ['SYNTHETIC cinema','Дозвілля',null,'travel'],
  ['SYNTHETIC gift','Сімейні виплати',null,'gifts_charity'],
 ])('applies the confirmed category for %s',(description,sourceCategory,mcc,categoryCode)=>{
  expect(classifyPersonalEntry({direction:'debit',entryKind:'terminal_personal_expense',description,sourceCategory,mcc})).toMatchObject({state:'assigned',categoryCode,terminalSpend:true});
 });
 it('does not broaden merchant rules to unrelated labels or override proven movements',()=>{
  for(const description of ['SYNTHETIC Circles Coffee','SYNTHETIC MUELLERSON'])expect(classifyPersonalEntry({direction:'debit',entryKind:'terminal_personal_expense',description,sourceCategory:null})).not.toMatchObject({method:'user_rule'});
  expect(classifyPersonalEntry({direction:'debit',entryKind:'fx_buy',description:'SYNTHETIC Circle Coffee',sourceCategory:null})).toMatchObject({categoryCode:'transfers',terminalSpend:false});
  expect(classifyPersonalEntry({direction:'debit',entryKind:'terminal_personal_expense',description:'SYNTHETIC purchase 970 EUR',sourceCategory:'Продукти'})).toMatchObject({categoryCode:'groceries',terminalSpend:true});
 });
});

const legacy=()=>reportSchema.parse({version:1,coverage:{start:'2090-01-01',end:'2090-01-31',generatedAt:'2090-02-01'},ledgerDigest:'synthetic',sources:[],collections:[],
 rows:[
  {id:'synthetic-care',group:'Догляд',description:'SYNTHETIC care',eur:1100},
  {id:'synthetic-health',group:'Здоров’я та добавки',description:'SYNTHETIC health',eur:2200},
  {id:'synthetic-sport',group:'Спорт',description:'SYNTHETIC sport',eur:3300},
  {id:'synthetic-leisure',group:'Дозвілля',description:'SYNTHETIC leisure',eur:4400},
  {id:'synthetic-car',group:'Авто та пальне',description:'SYNTHETIC car',eur:5500},
  {id:'synthetic-transit',group:'Інший транспорт',description:'SYNTHETIC transit',eur:6600},
  {id:'synthetic-family',group:'Сімейні виплати',description:'SYNTHETIC family',eur:7700},
  {id:'synthetic-gift',group:'Покупки, техніка, одяг, подарунки, дім',originalCategory:'Подарунки та благодійність',description:'SYNTHETIC gift',eur:8800},
  {id:'synthetic-coffee',group:'Кафе, ресторани, кава',description:'SYNTHETIC Circle Coffee',eur:900},
  {id:'synthetic-refund',group:'Повернення без категорії',description:'SYNTHETIC unlinked refund',eur:-700},
 ].map(r=>({...r,date:'2090-01-15',provider:'SYNTHETIC bank',source:'synthetic',homeGroup:r.group})),
 months:[{month:'2090-01',income:100000,tax:0,bank:0,netSpending:39800,grossSpending:39800,partial:false}],
 plan:{'Догляд':1000,'Здоров’я та добавки':2000,'Спорт':3000,'Дозвілля':4000,'Авто та пальне':5000,'Інший транспорт':6000,'Сімейні виплати':7000,'Покупки, техніка, одяг, подарунки, дім':8000,'Кафе, ресторани, кава':9000}});

describe('category policy across report refresh',()=>{
 let root:string,db:EncryptedDatabase,store:WorkspaceStore;
 beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),'moneywave-policy-synthetic-'));db=await openEncryptedDatabase(join(root,'test.db'),Buffer.alloc(32,76));await applyMigrations(db);store=new WorkspaceStore(db);});
 afterEach(async()=>{await db.close();await rm(root,{recursive:true,force:true});});
 it('normalizes old reports and budget baselines without changing spending or duplicating plans',async()=>{
  const raw=legacy(),original=structuredClone(raw);await store.seed(raw);let w=await store.read();
  expect(w.report.rows.map(r=>r.homeGroup)).toEqual(['Дім, здоров’я та догляд','Дім, здоров’я та догляд','Відпустки та подорожі','Відпустки та подорожі','Авто','Авто','Подарунки','Подарунки','Кава','Інші виплати']);
  expect(w.report.plan['Дім, здоров’я та догляд']).toBe(3000);expect(w.report.plan['Відпустки та подорожі']).toBe(7000);expect(w.report.plan['Авто']).toBe(11000);
  expect(summary(w.report,w.state,'2090').plan).toBe(45000);expect(summary(w.report,w.state,'2090').net).toBe(39800);expect(raw).toEqual(original);
  await store.mutate({action:'budget',revision:w.revision,category:'Відпустки та подорожі',from:'2090-01',amount:8888});w=await store.read();
  await store.mutate({action:'budget',revision:w.revision,category:'Дім, здоров’я та догляд',from:'2090-01',amount:7777});
  w=await store.read();await store.mutate({action:'row',revision:w.revision,id:'synthetic-coffee',category:'SYNTHETIC manual category',name:'SYNTHETIC chosen name',note:'SYNTHETIC note',excluded:false});
  w=await store.read();await store.mutate({action:'row',revision:w.revision,id:'synthetic-family',category:'Купівля валюти',note:'SYNTHETIC confirmed movement',excluded:true});
  const saved=await store.read(),totals=summary(saved.report,saved.state,'2090');
  raw.coverage.generatedAt='2090-02-02';await store.seed(raw,true);w=await store.read();
  expect(w.state.overrides).toEqual(saved.state.overrides);expect(w.state.budgets).toEqual(saved.state.budgets);
  expect(summary(w.report,w.state,'2090').plan).toBe(totals.plan);expect(summary(w.report,w.state,'2090').net).toBe(totals.net);
  expect(effectiveRows(w.report,w.state).find(r=>r.id==='synthetic-family')?.excluded).toBe(true);
  expect(await store.seed(raw,true)).toMatchObject({inserted:false});
 });
 it('lets an explicit combined limit override legacy component baselines',()=>{
  const raw=legacy(),state=initialState(raw);state.budgets=[{category:'Дім, здоров’я та догляд',from:'2090-01',amount:5555}];
  expect(normalizeWorkspaceCategories(raw,state).budgets).toEqual(state.budgets);
 });
 it('synchronizes an exact FX correction and its later manual replacement with processing',async()=>{
  await db.run("INSERT INTO providers(id,code,display_name) VALUES('synthetic-provider','synthetic','Synthetic')");
  await db.run("INSERT INTO accounts(id,provider_id,owner_scope,account_type,currency,display_name,identifier_hmac) VALUES('synthetic-account','synthetic-provider','PERSONAL','card','EUR','Synthetic',?)",['a'.repeat(64)]);
  await db.run("INSERT INTO ledger_entries(id,account_id,amount_minor,currency,direction,occurred_at,entry_kind,private_description) VALUES('synthetic-family','synthetic-account',-7700,'EUR','debit','2090-01-15','terminal_personal_expense','SYNTHETIC purchase')");
  await store.seed(legacy());await store.mutate({action:'row',revision:0,id:'synthetic-family',category:'Купівля валюти',excluded:true,note:''});
  await saveWorkspaceCategoryRules(db);await new CategoryPolicyService(db).apply();
  expect(await db.get("SELECT entry_kind AS kind FROM ledger_entries WHERE id='synthetic-family'")).toEqual({kind:'unlinked_transfer_out'});
  let w=await store.read();await store.mutate({action:'row',revision:w.revision,id:'synthetic-family',category:'SYNTHETIC manual choice',excluded:false,note:''});
  await saveWorkspaceCategoryRules(db);await new ReclassificationPreparationService(db).run();await new EntryClassificationService(db).refresh();await new CategoryPolicyService(db).apply();
  expect(await db.get("SELECT entry_kind AS kind FROM ledger_entries WHERE id='synthetic-family'")).toEqual({kind:'terminal_personal_expense'});
  expect(await db.get(`SELECT c.display_name AS name FROM category_assignments a JOIN categories c ON c.id=a.category_id WHERE a.ledger_entry_id='synthetic-family' ORDER BY a.assigned_at DESC,a.rowid DESC LIMIT 1`)).toEqual({name:'SYNTHETIC manual choice'});
  w=await store.read();expect(w.state.overrides['synthetic-family'].excluded).toBe(false);
  expect((await saveWorkspaceCategoryRules(db)).saved).toBe(0);
 });
 it('categorizes new rows after refresh and carries an exact correction to a newly arrived linked refund',async()=>{
  const raw=legacy();await store.seed(raw);await store.mutate({action:'row',revision:0,id:'synthetic-coffee',category:'SYNTHETIC chosen',note:'SYNTHETIC parent note',excluded:false});
  raw.rows.push({...raw.rows[0],id:'synthetic-new-mueller',group:'Покупки',homeGroup:'Покупки',description:'SYNTHETIC MUELLER',eur:500});
  raw.rows.push({...raw.rows[0],id:'synthetic-new-credit',group:'Кафе, ресторани, кава',homeGroup:'Кафе, ресторани, кава',description:'SYNTHETIC refund',purchaseId:'synthetic-coffee',eur:-200});
  raw.months[0].netSpending+=300;raw.months[0].grossSpending+=300;await store.seed(raw,true);
  const w=await store.read(),rows=effectiveRows(w.report,w.state);
  expect(rows.find(r=>r.id==='synthetic-new-mueller')?.group).toBe('Дім, здоров’я та догляд');
  expect(rows.find(r=>r.id==='synthetic-new-credit')).toMatchObject({group:'SYNTHETIC chosen',eur:-200});
 });
});

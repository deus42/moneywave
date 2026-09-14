import {afterEach,describe,expect,it} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openEncryptedDatabase,type EncryptedDatabase} from '@/server/db/database';
import {applyMigrations} from '@/server/db/migrations';
import {WorkspaceStore} from '@/server/workspace/store';
import {normalizeReportCategories,normalizeWorkspaceCategories} from '@/server/workspace/category-policy';
import {budgetFor,changeState,initialState,mutationSchema,reportSchema,stateSchema,summary} from '@/server/workspace/model';

const fixture=()=>reportSchema.parse({version:1,coverage:{start:'2089-01-01',end:'2091-12-31',generatedAt:'2092-01-01'},ledgerDigest:'synthetic',sources:[],rows:[],collections:[],plan:{Books:1000},
 months:Array.from({length:36},(_,i)=>({month:`${2089+Math.floor(i/12)}-${String(i%12+1).padStart(2,'0')}`,income:0,tax:0,bank:0,grossSpending:0,netSpending:0,partial:false}))});
const budget=(from:string,to:string,amount=2000)=>({action:'budget' as const,revision:0,category:'Books',from,to,amount});
const schedule=(periods:{from:string;to?:string;amount:number}[],revision=0)=>({action:'budgetPeriods' as const,category:'Books',periods,revision});

describe('complete category budget schedules',()=>{
 it('adds and removes independent periods without restoring an imported baseline',()=>{
  const report=fixture(),original=initialState(report);
  const periods=[{from:'2089-01',to:'2089-12',amount:2000},{from:'2090-01',to:'2090-12',amount:3000}];
  let state=changeState(report,original,schedule(periods));
  expect(summary(report,state,'all').plan).toBe(60000);
  state=changeState(report,state,schedule([periods[1]]));
  expect(summary(report,state,'2089').plan).toBe(0);
  expect(summary(report,state,'2090').plan).toBe(36000);
  state=changeState(report,state,schedule([]));
  expect(summary(report,state,'all').plan).toBe(0);
  expect(state.budgets).toEqual([]);
  expect(original).toEqual(initialState(report));
 });
 it('rejects overlap and duplicate starts and permits adjacent periods or a final unbounded period',()=>{
  const first={from:'2090-01',to:'2090-06',amount:2000};
  expect(mutationSchema.safeParse(schedule([first,{from:'2090-06',to:'2090-12',amount:3000}])).success).toBe(false);
  expect(mutationSchema.safeParse(schedule([first,first])).success).toBe(false);
  expect(mutationSchema.safeParse(schedule([first,{from:'2090-07',amount:3000}])).success).toBe(true);
 });
});

describe('bounded monthly budget versions',()=>{
 it('retains both inclusive ends and stops without reviving an older limit',()=>{
  const report=fixture(),legacy=changeState(report,initialState(report),{action:'budget',revision:0,category:'Books',from:'2089-01',amount:1500});
  const state=changeState(report,legacy,budget('2090-01','2090-12'));
  expect(state.budgets.at(-1)).toMatchObject({from:'2090-01',to:'2090-12'});
  expect(budgetFor(report,state,'Books','2089-12')).toBe(1500);
  expect(budgetFor(report,state,'Books','2090-01')).toBe(2000);
  expect(budgetFor(report,state,'Books','2090-12')).toBe(2000);
  expect(budgetFor(report,state,'Books','2091-01')).toBe(0);
 });
 it('sums separate annual limits and keeps gaps outside the plan',()=>{
  const report=fixture();let state=changeState(report,initialState(report),budget('2089-01','2089-12',2000));
  state=changeState(report,state,budget('2090-01','2090-12',3000));
  expect(summary(report,state,'2089').plan).toBe(24000);
  expect(summary(report,state,'2090').plan).toBe(36000);
  expect(summary(report,state,'2091').plan).toBe(0);
  expect(summary(report,state,'all').plan).toBe(60000);
  state=changeState(report,state,budget('2090-01','2090-01',0));
  expect(summary(report,state,'2090').plan).toBe(0);
  expect(summary(report,state,'2089').plan).toBe(24000);
 });
 it('rejects reversed or malformed end months while accepting a single month',()=>{
  expect(mutationSchema.safeParse(budget('2090-03','2090-02')).success).toBe(false);
  expect(mutationSchema.safeParse(budget('2090-03','2090-13')).success).toBe(false);
  expect(mutationSchema.safeParse(budget('2090-03','2090-03')).success).toBe(true);
  const report=fixture(),state=initialState(report);
  expect(stateSchema.safeParse({...state,budgets:[{from:'2090-03',to:'2090-02',category:'Books',amount:2000}]}).success).toBe(false);
 });
 it('keeps legacy open-ended versions readable and effective',()=>{
  const report=fixture(),state=stateSchema.parse({...initialState(report),budgets:[{from:'2090-01',category:'Books',amount:2000}]});
  expect(budgetFor(report,state,'Books','2091-12')).toBe(2000);
  expect(budgetFor(report,state,'Books','2089-12')).toBe(1000);
 });
 it('preserves bounded combined limits when a legacy report needs category normalization',()=>{
  const report=fixture();report.plan={'Спорт':1000,'Дозвілля':2000};
  const state=initialState(report);state.budgets=[{category:'Відпустки та подорожі',from:'2090-01',to:'2090-12',amount:4000}];
  expect(normalizeWorkspaceCategories(report,state).budgets).toEqual(state.budgets);
 });
 it('retains each component end when merging legacy category limits',()=>{
  const report=fixture();report.plan={'Спорт':1000,'Дозвілля':2000};
  const state=initialState(report);state.budgets=[{category:'Спорт',from:'2090-01',to:'2090-06',amount:3000},{category:'Дозвілля',from:'2090-01',to:'2090-12',amount:4000}];
  const merged=normalizeWorkspaceCategories(report,state),normalized=normalizeReportCategories(report);
  expect(budgetFor(normalized,merged,'Відпустки та подорожі','2090-06')).toBe(7000);
  expect(budgetFor(normalized,merged,'Відпустки та подорожі','2090-07')).toBe(4000);
  expect(budgetFor(normalized,merged,'Відпустки та подорожі','2091-01')).toBe(0);
 });
});

describe('encrypted budget period persistence',()=>{
 let directory:string|undefined,db:EncryptedDatabase|undefined;
 afterEach(async()=>{await db?.close();if(directory)await rm(directory,{recursive:true,force:true});});
 it('saves and clears a schedule atomically, preserves other categories and undoes removal',async()=>{
  directory=await mkdtemp(join(tmpdir(),'moneywave-budget-synthetic-'));
  const path=join(directory,'test.db');db=await openEncryptedDatabase(path,Buffer.alloc(32,82));await applyMigrations(db);
  let store=new WorkspaceStore(db);await store.seed(fixture());
  await store.mutate({action:'budget',revision:0,category:'Other',from:'2090-01',amount:1000});
  await store.mutate(schedule([{from:'2090-01',to:'2090-12',amount:2000}],1));
  await expect(store.mutate(schedule([],1))).rejects.toThrow('REVISION_CONFLICT');
  await store.mutate(schedule([],2));
  await db.close();db=await openEncryptedDatabase(path,Buffer.alloc(32,82));store=new WorkspaceStore(db);
  let w=await store.read();expect(budgetFor(w.report,w.state,'Books','2090-06')).toBe(0);
  expect(budgetFor(w.report,w.state,'Other','2090-06')).toBe(1000);
  const refreshed=fixture();refreshed.coverage.generatedAt='2092-01-02';await store.seed(refreshed,true);
  w=await store.read();expect(budgetFor(w.report,w.state,'Books','2090-06')).toBe(0);
  await store.mutate(schedule([{from:'2090-01',to:'2090-12',amount:2000}],4));
  await store.mutate(schedule([],5));await store.mutate({action:'undo',revision:6});
  w=await store.read();expect(budgetFor(w.report,w.state,'Books','2090-06')).toBe(2000);
 });
 it('preserves the end across reopen, unrelated edits, report refresh and undo',async()=>{
  directory=await mkdtemp(join(tmpdir(),'moneywave-budget-synthetic-'));
  const path=join(directory,'test.db');db=await openEncryptedDatabase(path,Buffer.alloc(32,82));await applyMigrations(db);
  let store=new WorkspaceStore(db);await store.seed(fixture());await store.mutate(budget('2090-01','2090-12'));
  await db.close();db=await openEncryptedDatabase(path,Buffer.alloc(32,82));store=new WorkspaceStore(db);
  expect((await store.read()).state.budgets[0]).toMatchObject({to:'2090-12'});
  await store.mutate({action:'categoryName',revision:1,category:'Books',name:'SYNTHETIC Reading'});
  const refreshed=fixture();refreshed.coverage.generatedAt='2092-01-02';await store.seed(refreshed,true);
  expect((await store.read()).state.budgets[0]).toMatchObject({to:'2090-12'});
  await store.mutate({...budget('2090-01','2090-06'),revision:3});
  expect((await store.read()).state.budgets).toHaveLength(1);
  await store.mutate({action:'undo',revision:4});
  const readback=await store.read();expect(readback.state.budgets[0]).toMatchObject({to:'2090-12'});
  expect(summary(readback.report,readback.state,'2091').plan).toBe(0);
  expect((await db.get<{n:number}>('SELECT count(*) AS n FROM ledger_entries'))?.n).toBe(0);
 });
});

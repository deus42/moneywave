import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {describe,expect,it} from 'vitest';
import {openEncryptedDatabase} from '../../src/server/db/database';
import {applyMigrations} from '../../src/server/db/migrations';
import {WorkspaceStore} from '../../src/server/workspace/store';
import {collectionSchema,purchaseDetailsSchema,effectiveRows,summary,reportSchema} from '../../src/server/workspace/model';

const details={category:'Synthetic equipment',items:[{id:'item',name:'SYNTHETIC device',category:'Synthetic electronics',classification:'inferred' as const,sourceTitle:'SYNTHETIC device and original specification',quantity:2,displayedUnitPrice:12000,asin:'B000000000',sourceReference:'123-1234567-1234567'}],sources:[{kind:'amazon' as const,label:'Synthetic retailer',reference:'123-1234567-1234567',orderId:'123-1234567-1234567',artifactHash:'a'.repeat(64),date:'2090-01-01',status:'unknown' as const,amounts:[{label:'Grand Total',eur:25000}]}]};
const purchase=collectionSchema.parse({id:'synthetic-purchase',kind:'purchase',name:'SYNTHETIC acquisition',start:'2090-01-01',end:'2090-01-01',budget:null,rowIds:[],purchaseDetails:details});

describe('purchase acquisition evidence',()=>{
 it('persists encrypted metadata through save, reopen, unrelated changes and undo without creating spending',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'moneywave-purchase-synthetic-')),path=join(directory,'test.db'),key=Buffer.alloc(32,72);
  let db=await openEncryptedDatabase(path,key);
  try{
   await applyMigrations(db);let store=new WorkspaceStore(db);
   const report=reportSchema.parse({version:2,coverage:{start:'2090-01-01',end:'2090-01-31',generatedAt:'2090-02-01'},rows:[],months:[{month:'2090-01',income:0,tax:0,bank:0,netSpending:0,grossSpending:0,partial:false}],plan:{},collections:[],sources:[],ledgerDigest:'synthetic'});
   await store.seed(report);const before=await store.read();
   await store.mutate({action:'collection',revision:0,collection:purchase});
   await db.close();db=await openEncryptedDatabase(path,key);store=new WorkspaceStore(db);
   const saved=await store.read();expect(saved.state.collections[0].purchaseDetails).toEqual(details);
   expect(effectiveRows(saved.report,saved.state)).toEqual([]);
   expect(summary(saved.report,saved.state,'all').net).toBe(summary(before.report,before.state,'all').net);
   await store.mutate({action:'collection',revision:1,collection:{...purchase,note:'SYNTHETIC note'}});
   await store.mutate({action:'undo',revision:2});
   expect((await store.read()).state.collections[0]).toEqual(purchase);
   expect((await readFile(path)).includes(Buffer.from('SYNTHETIC device'))).toBe(false);
  }finally{await db.close();await rm(directory,{recursive:true,force:true});key.fill(0);}
 });
 it('rejects executable product identifiers, negative prices and empty classifications',()=>{
  expect(()=>purchaseDetailsSchema.parse({...details,items:[{...details.items[0],asin:'javascript:alert(1)'}]})).toThrow();
  expect(()=>purchaseDetailsSchema.parse({...details,items:[{...details.items[0],displayedUnitPrice:-1}]})).toThrow();
  expect(()=>purchaseDetailsSchema.parse({...details,items:[{...details.items[0],category:''}]})).toThrow();
 });
});

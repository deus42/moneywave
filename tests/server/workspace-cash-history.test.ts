import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openEncryptedDatabase,type EncryptedDatabase} from '@/server/db/database';
import {applyMigrations} from '@/server/db/migrations';
import {cashHistory} from '@/server/workspace/cash-history';

describe('cash monthly source history (synthetic only)',()=>{
 let root:string,db:EncryptedDatabase;
 beforeEach(async()=>{
  root=await mkdtemp(join(tmpdir(),'moneywave-cash-history-'));db=await openEncryptedDatabase(join(root,'test.db'),Buffer.alloc(32,67));await applyMigrations(db);
  await db.run("INSERT INTO providers(id,code,display_name) VALUES('synthetic-provider','cash','SYNTHETIC')");
  for(const id of ['synthetic-cash','synthetic-other'])await db.run("INSERT INTO accounts(id,provider_id,owner_scope,account_type,currency,display_name) VALUES(?,'synthetic-provider','PERSONAL','cash','EUR',?)",[id,id]);
  await db.run("INSERT INTO manual_workbooks(id,contract_version) VALUES('synthetic-book','1')");
  for(const [id,kind,account] of [['synthetic-series','cash','synthetic-cash'],['synthetic-bank','bank',null],['synthetic-other-series','cash','synthetic-other']] as const){
   await db.run("INSERT INTO manual_position_series(id,lineage_id,label_key,display_name,provider_code,position_kind,currency,account_id) VALUES(?,'synthetic-book',?,?,'cash',?,'EUR',?)",[id,id.repeat(64).slice(0,64),id,kind,account]);
  }
  await db.run("INSERT INTO import_artifacts(id,sha256,encrypted_bytes,size_bytes,parser_kind,parser_version) VALUES('synthetic-artifact',?,X'0102',2,'manual_positions','1')",['a'.repeat(64)]);
  await db.run("INSERT INTO manual_import_batches(id,lineage_id,artifact_id,cell_count,backup_status) VALUES('synthetic-batch','synthetic-book','synthetic-artifact',2,'verified')");
  await fact('first','synthetic-series','2090-01','123456789012345');
  await fact('last','synthetic-series','2090-03','42000');
  await fact('future','synthetic-series','2090-04','50000');
  await fact('bank','synthetic-bank','2090-02','10000');
  await fact('other','synthetic-other-series','2090-01','70000');
  for(const [id,address] of [['source-one','G2'],['source-two','G8']])await db.run("INSERT INTO manual_source_cells(id,batch_id,sheet_name,cell_address,disposition,fact_id) VALUES(?,'synthetic-batch','Savings',?,'linked_to_ledger','first')",[id,address]);
 });
 async function fact(id:string,series:string,period:string,amount:string){await db.run('INSERT INTO manual_position_facts(id,series_id,period,amount_minor) VALUES(?,?,?,CAST(? AS INTEGER))',[id,series,period,amount]);}
 afterEach(async()=>{await db.close();await rm(root,{recursive:true,force:true});});
 it('keeps exact month observations and cell provenance without filling missing months or including future/bank positions',async()=>{
  const before=await db.all('SELECT * FROM manual_position_facts');await db.exec('PRAGMA query_only=ON');
  const rows=await cashHistory(db,'2090-03-31');
  expect(rows).toHaveLength(3);expect(rows.map(r=>r.period)).toEqual(['2090-03','2090-01','2090-01']);
  expect(rows.find(r=>r.period==='2090-01'&&r.accountId==='synthetic-cash')).toMatchObject({amountMinor:'123456789012345',conflicting:false,sources:[{sheet:'Savings',address:'G2'},{sheet:'Savings',address:'G8'}]});
  expect((await cashHistory(db,'2090-03-15')).map(r=>r.period)).toEqual(['2090-01','2090-01']);
  expect(await db.all('SELECT * FROM manual_position_facts')).toEqual(before);
 });
 it('keeps differing same-month sources unresolved and does not merge different accounts of the same currency',async()=>{
  await fact('conflict','synthetic-series','2090-01','12500');
  const rows=await cashHistory(db,'2090-01-31');
  expect(rows).toHaveLength(2);
  expect(rows.find(r=>r.accountId==='synthetic-cash')).toMatchObject({amountMinor:null,conflicting:true});
  expect(rows.find(r=>r.accountId==='synthetic-other')).toMatchObject({amountMinor:'70000',conflicting:false});
 });
});

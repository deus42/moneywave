import { beforeEach,afterEach,describe,it,expect } from 'vitest';
import { mkdtemp,rm,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openEncryptedDatabase,type EncryptedDatabase } from '@/server/db/database';
import { applyMigrations } from '@/server/db/migrations';
import { CryptoStore,addCryptoToCapital,cryptoObservationSchema } from '@/server/workspace/crypto';
import { FinanceCenters } from '@/server/read-model/finance-centers';

const observation=()=>({chain:'near' as const,account:'synthetic.near',source:'Pikespeak' as const,
 sourceUrl:'https://pikespeak.ai/account/synthetic.near?tab=global',observedAt:'2090-03-10T10:00:00.000Z',
 usdMinor:12500,evidenceSha256:'a'.repeat(64),parts:[{label:'SYNTHETIC liquid',quantity:'5',usdMinor:500},{label:'SYNTHETIC staking',quantity:'120',usdMinor:12000}],note:''});

describe('captured crypto NAV (independently synthetic)',()=>{
 let directory:string,db:EncryptedDatabase,store:CryptoStore;
 beforeEach(async()=>{directory=await mkdtemp(join(tmpdir(),'moneywave-crypto-'));db=await openEncryptedDatabase(join(directory,'synthetic.db'),Buffer.alloc(32,82));await applyMigrations(db);store=new CryptoStore(db,()=>new Date('2090-03-12'));});
 afterEach(async()=>{await db.close();await rm(directory,{recursive:true,force:true});});
 it('persists each wallet NAV once and converts exactly without counting its breakdown again',async()=>{
  await db.run("INSERT INTO fx_rate_cache(base_currency,quote_currency,requested_date,rate_text,source,publication_date) VALUES ('USD','EUR','2090-03-10','0.8','ECB','2090-03-10')");
  await store.save(observation());await store.save(observation());
  await db.close();db=await openEncryptedDatabase(join(directory,'synthetic.db'),Buffer.alloc(32,82));store=new CryptoStore(db,()=>new Date('2090-03-12'));
  const positions=await store.positions('2090-03-12');expect(positions).toHaveLength(1);expect(positions[0].eurMinor).toBe('10000');
  const base=await new FinanceCenters(db,()=>new Date('2090-03-12')).capital('2090-03-12','EUR');
  const combined=addCryptoToCapital({...base,knownAssetsMinor:'5000',knownLiabilitiesMinor:'1000',knownNetMinor:'4000'},positions);
  expect(combined).toMatchObject({knownNetMinor:'14000',knownAssetsMinor:'15000',knownLiabilitiesMinor:'1000',cryptoMinor:'10000',bankNetMinor:'4000',completeNetWorthMinor:null});
  expect((await db.get<{n:number}>('SELECT count(*) n FROM ledger_entries'))?.n).toBe(0);
  expect((await readFile(join(directory,'synthetic.db'))).includes(Buffer.from('synthetic.near'))).toBe(false);
 });
 it('never backfills a current crypto balance or later FX into earlier periods',async()=>{
  await store.save(observation());
  expect(await store.positions('2090-02-28')).toEqual([]);
  expect((await store.positions('2090-03-10'))[0].eurMinor).toBeNull();
  await db.run("INSERT INTO fx_rate_cache(base_currency,quote_currency,requested_date,rate_text,source,publication_date) VALUES ('USD','EUR','2090-03-11','0.75','ECB','2090-03-11')");
  expect((await store.positions('2090-03-10'))[0].eurMinor).toBeNull();
  expect((await store.positions('2090-03-11'))[0].eurMinor).toBe('9375');
  await store.save({...observation(),observedAt:'2090-03-11T10:00:00.000Z',usdMinor:10000,parts:[{label:'SYNTHETIC revised NAV',quantity:null,usdMinor:10000}]});
  expect((await store.positions('2090-03-11'))[0].usdMinor).toBe(10000);
  expect((await store.positions('2090-03-10'))[0].usdMinor).toBe(12500);
 });
 it('rejects conflicting, future and mismatched-source observations without replacing prior evidence',async()=>{
  await store.save(observation());
  await expect(store.save({...observation(),note:'changed'})).rejects.toThrow('CRYPTO_OBSERVATION_CONFLICT');
  await expect(store.save({...observation(),observedAt:'2090-04-01T00:00:00.000Z'})).rejects.toThrow('FUTURE_CRYPTO_OBSERVATION');
  expect(()=>cryptoObservationSchema.parse({...observation(),sourceUrl:'https://evil.invalid/account/synthetic.near'})).toThrow();
  expect(()=>cryptoObservationSchema.parse({...observation(),usdMinor:99999})).toThrow();
  expect((await store.positions('2090-03-12'))[0].note).toBe('');
 });
 it('normalizes Ethereum identity and preserves unpriced tokens as unknown',async()=>{
  const account='0x'+'ab'.repeat(20),row={...observation(),chain:'ethereum' as const,account,source:'Etherscan' as const,sourceUrl:`https://etherscan.io/address/${account}`,parts:[{label:'SYNTHETIC token',quantity:'125',usdMinor:12500},{label:'SYNTHETIC NFT',quantity:null,usdMinor:null}]};
  await store.save(row);await store.save({...row,account:'0x'+'AB'.repeat(20)});
  const positions=await store.positions('2090-03-12');expect(positions).toHaveLength(1);expect(positions[0].parts[1].usdMinor).toBeNull();
 });
});

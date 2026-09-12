import {readFile,realpath} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {join,relative,resolve} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {cryptoHistorySchema} from '../src/server/workspace/crypto-history';
import {getDatabase,getSecretStore} from '../src/server/runtime/services';
import {resolveMoneyWavePaths} from '../src/server/runtime/paths';
import {createVerifiedBackup} from '../src/server/db/backup';
import {ledgerFingerprint,WorkspaceStore} from '../src/server/workspace/store';

async function localFile(path:string){
 const root=await realpath(resolve('data')),file=await realpath(resolve(path)),rel=relative(root,file);
 if(!rel||rel.startsWith('..'))throw new Error('LOCAL_DATA_PATH_REQUIRED');
 const bytes=await readFile(file);if(!bytes.length||bytes.length>5_000_000)throw new Error('HISTORY_FILE_SIZE');return bytes;
}
async function run(){
 const args=process.argv.slice(2);if(!args[0]||args.slice(1).some(a=>a!=='--commit'))throw new Error('HISTORY_ARGUMENTS');
 const bundle=z.object({history:cryptoHistorySchema,evidence:z.array(z.object({sha256:z.string().regex(/^[a-f0-9]{64}$/u),path:z.string()}))}).parse(JSON.parse((await localFile(args[0])).toString('utf8')));
 const now=new Date().toISOString();
 for(const quote of bundle.history.prices){
  if(quote.capturedAt>now||quote.month>now.slice(0,7))throw new Error('FUTURE_HISTORY_PRICE');
  const evidence=bundle.evidence.find(e=>e.sha256===quote.evidenceSha256);if(!evidence)throw new Error('HISTORY_EVIDENCE_MISSING');
  const bytes=await localFile(evidence.path);if(createHash('sha256').update(bytes).digest('hex')!==evidence.sha256)throw new Error('HISTORY_EVIDENCE_CHANGED');
  const rows=z.array(z.array(z.union([z.string(),z.number()]))).parse(JSON.parse(bytes.toString('utf8')));
  const first=Date.parse(quote.month+'-01T00:00:00.000Z'),matches=rows.filter(row=>row[0]===first);
  if(matches.length!==1||matches[0][1]!==quote.open)throw new Error('HISTORY_PRICE_READBACK_FAILED');
 }
 const db=await getDatabase();try{
  for(const holding of bundle.history.holdings){
   if(holding.confirmedAt>now)throw new Error('FUTURE_HOLDING_CONFIRMATION');
   const rows=await db.all<{payload_json:string}>('SELECT payload_json FROM crypto_observations WHERE wallet_key=? AND observed_at=?',[`${holding.observation.chain}:${holding.observation.account.toLowerCase()}`,holding.observation.observedAt]);
   if(rows.length!==1||!isDeepStrictEqual(JSON.parse(rows[0].payload_json),holding.observation))throw new Error('HOLDING_SOURCE_CHANGED');
  }
  console.log('CRYPTO_HISTORY_PREVIEW_PASS');if(!args.includes('--commit'))return;
  const store=new WorkspaceStore(db),before=await store.read(),fingerprint=await ledgerFingerprint(db),key=await getSecretStore().get('database-key');
  try{await createVerifiedBackup({database:db,key,destinationPath:join(resolveMoneyWavePaths().backupDirectory,`crypto-history-${randomUUID()}.backup`),reason:'manual'});}finally{key.fill(0);}
  const result=await store.installCryptoHistory(bundle.history,before.revision),after=await store.read();
  if(!isDeepStrictEqual(after.report.cryptoHistory,bundle.history)||!isDeepStrictEqual(after.state,before.state)||!isDeepStrictEqual({...after.report,cryptoHistory:undefined},{...before.report,cryptoHistory:undefined})||fingerprint!==await ledgerFingerprint(db))throw new Error('HISTORY_PRESERVATION_FAILED');
  console.log(result.inserted?'CRYPTO_HISTORY_SAVED_VERIFIED':'CRYPTO_HISTORY_ALREADY_SAVED');
 }finally{await db.close();}
}
run().catch(error=>{console.error(error instanceof Error&&/^[A-Z_]+$/u.test(error.message)?error.message:'CRYPTO_HISTORY_IMPORT_FAILED');process.exitCode=1;});

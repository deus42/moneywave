import { readFile,realpath } from 'node:fs/promises';
import { createHash,randomUUID } from 'node:crypto';
import { resolve,relative,join } from 'node:path';
import { z } from 'zod';
import { getDatabase,getSecretStore } from '../src/server/runtime/services';
import { resolveMoneyWavePaths } from '../src/server/runtime/paths';
import { createVerifiedBackup } from '../src/server/db/backup';
import { ledgerFingerprint } from '../src/server/workspace/store';
import { CryptoStore,cryptoObservationSchema } from '../src/server/workspace/crypto';

async function localFile(path:string){
  const file=await realpath(resolve(path)),root=await realpath(resolve('data')),rel=relative(root,file);
  if(!rel||rel.startsWith('..'))throw new Error('LOCAL_DATA_PATH_REQUIRED');
  return readFile(file);
}
const bundle=z.array(z.object({observation:cryptoObservationSchema,evidencePath:z.string()})).min(1).max(10).parse(JSON.parse((await localFile(process.argv[2]??'')).toString('utf8')));
for(const item of bundle)if(createHash('sha256').update(await localFile(item.evidencePath)).digest('hex')!==item.observation.evidenceSha256)throw new Error('CRYPTO_SOURCE_CHANGED');
const database=await getDatabase(),before=await ledgerFingerprint(database),key=await getSecretStore().get('database-key');
try{
  await createVerifiedBackup({database,key,destinationPath:join(resolveMoneyWavePaths().backupDirectory,`crypto-observations-${randomUUID()}.backup`),reason:'manual'});
  const store=new CryptoStore(database);
  await database.transaction(async()=>{for(const item of bundle){const digest=await store.save(item.observation);if(!await database.get('SELECT digest FROM crypto_observations WHERE digest=?',[digest]))throw new Error('CRYPTO_READBACK_FAILED');}});
  if(before!==await ledgerFingerprint(database))throw new Error('BANK_EVIDENCE_CHANGED');
  console.log('CRYPTO_OBSERVATIONS_SAVED_BANK_EVIDENCE_UNCHANGED');
}finally{key.fill(0);await database.close();}

import { resolve } from 'node:path';
import { isIPv4 } from 'node:net';
import { FinanceCenters } from '../src/server/read-model/finance-centers';
import { CryptoStore } from '../src/server/workspace/crypto';
import { createWorkspaceServer } from '../src/server/workspace/http';
import { ledgerFingerprint, WorkspaceStore } from '../src/server/workspace/store';
import { connectHostDatabase } from '../src/server/db/stdio-database';

async function main(){
  const origin=process.env.MONEYWAVE_TAILSCALE_ORIGIN,login=process.env.MONEYWAVE_TAILSCALE_LOGIN,proxyAddress=process.env.MONEYWAVE_PROXY_ADDRESS;
  const port=Number(process.env.MONEYWAVE_PORT??43822);
  if(!origin||!login||!proxyAddress||!isIPv4(proxyAddress)||!Number.isInteger(port)||port<1024||port>65535)throw new Error('STAGE_CONFIG_INVALID');
  const database=await connectHostDatabase();
  const store=new WorkspaceStore(database),{report}=await store.read();
  const server=createWorkspaceServer({store,centers:new FinanceCenters(database),crypto:new CryptoStore(database),staticDirectory:resolve('src/web'),sourceCurrent:report.ledgerDigest===await ledgerFingerprint(database),tailscale:{origin,login,proxyAddress},release:process.env.MONEYWAVE_RELEASE_ID});
  server.listen(port,'0.0.0.0',()=>console.error('STAGE_READY'));
  server.on('error',()=>{console.error('STAGE_LISTEN_FAILED');void database.close().finally(()=>process.exit(1));});
  for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>server.close(()=>{void database.close().finally(()=>process.exit(0));}));
}
main().catch(()=>{console.error('STAGE_START_FAILED');process.exit(1);});

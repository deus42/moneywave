import { resolve } from 'node:path';
import { getDatabase } from '../src/server/runtime/services';
import { FinanceCenters } from '../src/server/read-model/finance-centers';
import { ledgerFingerprint, WorkspaceStore } from '../src/server/workspace/store';
import { createWorkspaceServer } from '../src/server/workspace/http';
import { CryptoStore } from '../src/server/workspace/crypto';

const database = await getDatabase();
const store = new WorkspaceStore(database);
const {report} = await store.read();
const sourceCurrent = report.ledgerDigest === await ledgerFingerprint(database);
const server = createWorkspaceServer({store,centers:new FinanceCenters(database),crypto:new CryptoStore(database),staticDirectory:resolve('src/web'),sourceCurrent});
const port = Number(process.env.MONEYWAVE_PORT ?? 43821);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT_INVALID');
server.listen(port,'127.0.0.1',()=> console.log(`MoneyWave http://127.0.0.1:${port}/`));
server.on('error',async () => { console.error('WORKSPACE_LISTEN_FAILED'); await database.close(); process.exitCode=1; });
for (const signal of ['SIGINT','SIGTERM'] as const) process.on(signal,()=>server.close(async () => {await database.close();process.exit(0);}));

import { foreignStatementCategory } from '../src/domain/foreign-statement-semantics';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getDatabase, getSecretStore, withImportService, refreshDerivedState, refreshReportingValuations } from '../src/server/runtime/services';
import { deriveIdentifierHmacKey } from '../src/server/secrets/key-derivation';
import { createVerifiedBackup } from '../src/server/db/backup';
import { resolveMoneyWavePaths } from '../src/server/runtime/paths';
import { ErsteStatementAdapter } from '../src/server/import/erste';
import { RevolutStatementAdapter } from '../src/server/import/revolut';
import { WiseStatementAdapter } from '../src/server/import/wise';
import { CashService } from '../src/server/cash/service';
import { FinanceCenters } from '../src/server/read-model/finance-centers';
import type { EncryptedDatabase } from '../src/server/db/database';

const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
async function counts(db:EncryptedDatabase) {
 const result:Record<string,number>={};
 for(const table of ['accounts','import_artifacts','source_records','ledger_entries','transaction_evidence','balance_snapshots','manual_position_series','manual_position_facts'])
  result[table]=(await db.get<{n:number}>(`SELECT COUNT(*) AS n FROM ${table}`))!.n;
 return result;
}
async function run() {
 const args=process.argv.slice(2);
 if(args.some(a=>!['--commit','--confirm-same-manual-accounts'].includes(a)))throw new Error('FOREIGN_IMPORT_ARGUMENTS');
 const commit=args.includes('--commit');
 if(commit&&!args.includes('--confirm-same-manual-accounts'))throw new Error('MANUAL_IDENTITY_CONFIRMATION_REQUIRED');
 const db=await getDatabase(),key=await getSecretStore().get('database-key'),identifierKey=deriveIdentifierHmacKey(key);
 const paths=resolveMoneyWavePaths();
 const buffers:Buffer[]=[];
 try {
  if(!commit)await db.exec('PRAGMA query_only=ON');
  const plans=[];
  for(const provider of ['erste','wise','revolut'] as const) {
   const inbox=join(process.cwd(),'data',provider);
   const files=(await readdir(inbox,{withFileTypes:true})).filter(f=>f.isFile()&& /\.(csv|xlsx)$/iu.test(f.name));
   if(files.length!==1)throw new Error('FOREIGN_ARTIFACT_COUNT_INVALID');
   const path=join(inbox,files[0]!.name);
   const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
   let bytes:Buffer;
   try {
    const stat=await handle.stat();if(!stat.isFile()||stat.uid!==process.getuid?.()||!stat.size||stat.size>25*1024*1024)throw new Error('FOREIGN_SOURCE_INVALID');
    bytes=await handle.readFile();const after=await handle.stat();
    if(after.mtimeMs!==stat.mtimeMs||after.size!==stat.size)throw new Error('FOREIGN_SOURCE_CHANGED');
   }finally{await handle.close();}
   buffers.push(bytes);
   const series=await db.all<{id:string;account:string|null}>("SELECT id,account_id AS account FROM manual_position_series WHERE provider_code=? AND currency='EUR' AND position_kind='bank'",[provider]);
   if(series.length!==1)throw new Error('MANUAL_SERIES_AMBIGUOUS');
   const wiseAccountIdentifier=`wise-local-user-binding:${series[0]!.id}`;
   const revolutAccountIdentifier=`revolut-local-user-binding:${series[0]!.id}`;
   const adapter=provider==='erste'?new ErsteStatementAdapter({identifierKey}):provider==='wise'?new WiseStatementAdapter({identifierKey,accountIdentifier:wiseAccountIdentifier}):new RevolutStatementAdapter({identifierKey,accountIdentifier:revolutAccountIdentifier});
   // The adapters expose a common import contract but source-specific parse types.
   const inspection = provider==='erste'
    ? (()=>{const a=new ErsteStatementAdapter({identifierKey});const p=a.parse(bytes);return {identifier:a.discoverAccounts(p)[0]!,normalize:(accountId:string)=>a.normalize(p,{mappingComplete:true,ownership:new Map([[a.discoverAccounts(p)[0]!.identifierHash,{accountId,ownerScope:'PERSONAL'}]])})};})()
    : provider==='wise' ? (()=>{const a=new WiseStatementAdapter({identifierKey,accountIdentifier:wiseAccountIdentifier});const p=a.parse(bytes);return {identifier:a.discoverAccounts(p)[0]!,normalize:(accountId:string)=>a.normalize(p,{mappingComplete:true,ownership:new Map([[a.discoverAccounts(p)[0]!.identifierHash,{accountId,ownerScope:'PERSONAL'}]])})};})()
    : (()=>{const a=new RevolutStatementAdapter({identifierKey,accountIdentifier:revolutAccountIdentifier});const p=a.parse(bytes);return {identifier:a.discoverAccounts(p)[0]!,normalize:(accountId:string)=>a.normalize(p,{mappingComplete:true,ownership:new Map([[a.discoverAccounts(p)[0]!.identifierHash,{accountId,ownerScope:'PERSONAL'}]])})};})();
   const existing=await db.get<{id:string}>("SELECT id FROM accounts WHERE identifier_hmac=?",[inspection.identifier.identifierHash]);
   const accountId=existing?.id??`${provider}-account-${inspection.identifier.identifierHash.slice(0,24)}`;
   if(series[0]!.account&&series[0]!.account!==accountId)throw new Error('MANUAL_ACCOUNT_BINDING_CONFLICT');
   const normalized=inspection.normalize(accountId),reconciliation=adapter.reconcile(normalized);
   if(reconciliation.stateCounts.posted!==reconciliation.rowCount||reconciliation.issues.length)throw new Error('FOREIGN_PREFLIGHT_FAILED');
   plans.push({provider,path,bytes,sha:hash(bytes),accountId,seriesId:series[0]!.id,wiseAccountIdentifier,revolutAccountIdentifier,identifier:inspection.identifier,normalized});
   process.stdout.write(`${provider}_preview PASS rows=${reconciliation.rowCount}\n`);
  }
  if(!commit)return;
  const backup=await createVerifiedBackup({database:db,key,destinationPath:join(paths.backupDirectory,`before-foreign-${randomUUID()}.backup`),reason:'manual'});
  if(!backup.sizeBytes||backup.integrity!=='ok')throw new Error('FOREIGN_BACKUP_FAILED');
  process.stdout.write('foreign_backup PASS\n');
  const before=await counts(db);
  const oldLedger=await db.all<{id:string;data:string}>("SELECT id, json_array(account_id,CAST(amount_minor AS TEXT),currency,direction,occurred_at,private_description) AS data FROM ledger_entries");
  for(const plan of plans) {
   if(hash(await readFile(plan.path))!==plan.sha)throw new Error('FOREIGN_SOURCE_CHANGED');
   const existing=await db.get<{id:string}>('SELECT id FROM import_artifacts WHERE sha256=?',[plan.sha]);
   if(!existing) {
    const result=await withImportService(async service=>{
     const preview=await service.preview(plan.bytes);
     if(preview.providerCode!==plan.provider) {await service.rollback(preview.previewId);throw new Error('FOREIGN_PROVIDER_MISMATCH');}
     return service.commit({previewId:preview.previewId,mappingComplete:true,registrations:[{
      accountId:plan.accountId,displayName:`${plan.provider==='erste'?'Erste':plan.provider==='wise'?'Wise':'Revolut'} EUR`,ownerScope:'PERSONAL',accountType:'bank',currency:'EUR',
      identifierHash:plan.identifier.identifierHash,identifierKind:'account',maskedDisplay:plan.identifier.display,manualPositionSeriesId:plan.seriesId,
     }]});
    },plan.provider==='wise'?{wiseAccountIdentifier:plan.wiseAccountIdentifier}:plan.provider==='revolut'?{revolutAccountIdentifier:plan.revolutAccountIdentifier}:undefined);
    if(result.backupStatus!=='verified'||result.conflictsCreated||result.postedCount!==plan.normalized.rows.length)throw new Error('FOREIGN_COMMIT_READBACK_FAILED');
    process.stdout.write(`${plan.provider}_import PASS created=${result.canonicalEntriesCreated}\n`);
   } else process.stdout.write(`${plan.provider}_import PASS ALREADY_IMPORTED\n`);
   const artifact=await db.get<{bytes:Buffer}>('SELECT encrypted_bytes AS bytes FROM import_artifacts WHERE sha256=?',[plan.sha]);
   if(!artifact||hash(artifact.bytes)!==plan.sha)throw new Error('FOREIGN_ARTIFACT_READBACK_FAILED');artifact.bytes.fill(0);
   const actual=await db.all<{line:number;amount:string;date:string;currency:string}>(`SELECT sr.source_row_number AS line,CAST(te.observed_amount_minor AS TEXT) AS amount,le.occurred_at AS date,te.observed_currency AS currency
    FROM import_artifacts a JOIN import_batches b ON b.artifact_id=a.id JOIN source_records sr ON sr.batch_id=b.id
    JOIN transaction_evidence te ON te.source_record_id=sr.id JOIN ledger_entries le ON le.id=te.ledger_entry_id WHERE a.sha256=? ORDER BY sr.source_row_number`,[plan.sha]);
   const expected=plan.normalized.rows.map(r=>({line:r.sourceRowNumber,amount:r.observations[0]!.amountMinor.toString(),date:r.observations[0]!.occurredAt,currency:'EUR'}));
   if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('FOREIGN_ENTRY_READBACK_FAILED');
   if((await db.get<{account:string}>('SELECT account_id AS account FROM manual_position_series WHERE id=?',[plan.seriesId]))?.account!==plan.accountId)throw new Error('FOREIGN_BINDING_READBACK_FAILED');
  }
  // Add an audited normalization overlay; preserve original bytes and all existing
  // provider fields. This also upgrades artifacts imported before these semantics.
  const statementRows=await db.all<{sourceId:string;entryId:string;provider:string;metadata:string;direction:string;description:string;grouped:number}>(`
   SELECT sr.id AS sourceId,le.id AS entryId,p.code AS provider,sr.source_metadata_json AS metadata,le.direction,le.private_description AS description,
    EXISTS(SELECT 1 FROM movement_legs ml WHERE ml.ledger_entry_id=le.id) AS grouped
   FROM source_records sr JOIN transaction_evidence te ON te.source_record_id=sr.id JOIN ledger_entries le ON le.id=te.ledger_entry_id
   JOIN accounts a ON a.id=le.account_id JOIN providers p ON p.id=a.provider_id WHERE p.code IN ('erste','wise','revolut')`);
  let enriched=0;
  await db.transaction(async()=>{
   for(const row of statementRows){
    const metadata=JSON.parse(row.metadata) as Record<string,unknown>;
    const category=foreignStatementCategory(row.provider,metadata,row.direction,row.description??'');
    if(!category||metadata.statementCategory===category)continue;
    metadata.statementCategory=category;
    await db.run('UPDATE source_records SET source_metadata_json=? WHERE id=?',[JSON.stringify(metadata),row.sourceId]);
    if(!row.grouped){
     const manual=await db.get<{n:number}>("SELECT COUNT(*) AS n FROM category_assignments WHERE ledger_entry_id=? AND method IN ('manual','user_rule')",[row.entryId]);
     if(!manual?.n){await db.run("DELETE FROM category_assignments WHERE ledger_entry_id=? AND method NOT IN ('manual','user_rule')",[row.entryId]);await db.run("UPDATE ledger_entries SET entry_kind='unclassified' WHERE id=?",[row.entryId]);}
    }
    await db.run("INSERT INTO audit_events (id,event_code,entity_type,entity_id,safe_details_json) VALUES (?,'STATEMENT_SEMANTICS_DERIVED','source_record',?,?)",[randomUUID(),row.sourceId,JSON.stringify({version:'foreign-statement-semantics@1',category})]);
    enriched++;
   }
  });
  process.stdout.write(`foreign_statement_semantics PASS enriched=${enriched}\n`);
  await new CashService(db).run({openingDate:'2024-09-04',currencies:['UAH','EUR','USD']});
  const derived=await refreshDerivedState();
  const valuation=await refreshReportingValuations();
  process.stdout.write(`foreign_analysis PASS pending_categories=${derived.categorization.pendingOpenAI} pending_movements=${derived.reconciliation.pendingCandidates} missing_rates=${valuation.missingRateCount}\n`);
  for(const row of oldLedger) {
   const current=await db.get<{data:string}>("SELECT json_array(account_id,CAST(amount_minor AS TEXT),currency,direction,occurred_at,private_description) AS data FROM ledger_entries WHERE id=?",[row.id]);
   if(current?.data!==row.data)throw new Error('EXISTING_LEDGER_CHANGED');
  }
  for(const currency of ['EUR','USD','UAH'] as const) {
   const view=await new FinanceCenters(db).capital(undefined,currency);
   for(const plan of plans)if((view.positions.filter(p=>p.accountId===plan.accountId).length!==1 || view.positions.some(p=>p.id===`manual:${plan.seriesId}`)))throw new Error('FOREIGN_CAPITAL_DUPLICATION');
  }
  if((await db.get<{integrity_check:string}>('PRAGMA integrity_check'))?.integrity_check!=='ok'||(await db.all('PRAGMA foreign_key_check')).length)throw new Error('FOREIGN_DATABASE_INTEGRITY');
  for(const plan of plans)if(hash(await readFile(plan.path))!==plan.sha)throw new Error('FOREIGN_SOURCE_CHANGED');
  const after=await counts(db);process.stdout.write(`foreign_counts ${JSON.stringify({before,after})}\n`);
  await createVerifiedBackup({database:db,key,destinationPath:join(paths.backupDirectory,`after-foreign-${randomUUID()}.backup`),reason:'after_import'});
  process.stdout.write('foreign_readback PASS\n');
 } finally {buffers.forEach(b=>b.fill(0));identifierKey.fill(0);key.fill(0);await db.close();}
}
run().catch((error:unknown)=>{const code=error instanceof Error&&/^[A-Z][A-Z0-9_]{2,80}$/u.test(error.message)?error.message:'FOREIGN_IMPORT_FAILED';process.stdout.write(`foreign_import FAIL ${code}\n`);process.exitCode=1;});

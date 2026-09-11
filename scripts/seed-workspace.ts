import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, join, relative } from 'node:path';
import { getDatabase, getSecretStore } from '../src/server/runtime/services';
import { resolveMoneyWavePaths } from '../src/server/runtime/paths';
import { createVerifiedBackup } from '../src/server/db/backup';
import { reportSchema } from '../src/server/workspace/model';
import { ledgerFingerprint, WorkspaceStore } from '../src/server/workspace/store';

// Explicit local import only. No web route can read a filesystem path or seed a report.
const path = resolve(process.argv[2] ?? '');
const underData = relative(resolve('data'), path);
if (!process.argv[2] || underData.startsWith('..') || underData === '') throw new Error('LOCAL_DATA_PATH_REQUIRED');
const raw: unknown = JSON.parse(await readFile(path,'utf8'));
const report = reportSchema.parse(raw);
const database = await getDatabase();
const before = await ledgerFingerprint(database);
if (before !== report.ledgerDigest) throw new Error('REPORT_LEDGER_CHANGED');
const sourceManifest = (raw as {sourceFiles?: {path:string;sha256:string}[]}).sourceFiles;
if (!sourceManifest?.length) throw new Error('SOURCE_MANIFEST_REQUIRED');
for (const source of sourceManifest) {
  const sourcePath = resolve(source.path);
  if (relative(resolve('data'),sourcePath).startsWith('..')) throw new Error('SOURCE_PATH_DENIED');
  if (createHash('sha256').update(await readFile(sourcePath)).digest('hex') !== source.sha256) throw new Error('REPORT_SOURCE_CHANGED');
}
for (const row of report.rows.filter(r => r.source === 'ledger')) {
  if (!await database.get('SELECT id FROM ledger_entries WHERE id=?',[row.id])) throw new Error('REPORT_ROW_MISSING');
}
const key = await getSecretStore().get('database-key');
try {
  await createVerifiedBackup({database,key,destinationPath:join(resolveMoneyWavePaths().backupDirectory,`workspace-seed-${randomUUID()}.backup`),reason:'manual'});
  const result = await new WorkspaceStore(database).seed(report, process.argv.includes('--refresh'));
  if (before !== await ledgerFingerprint(database)) throw new Error('SOURCE_CHANGED');
  console.log(result.inserted ? 'WORKSPACE_SEEDED_ORIGINALS_UNCHANGED' : 'WORKSPACE_ALREADY_CURRENT');
} finally { key.fill(0); await database.close(); }

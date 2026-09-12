import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { openEncryptedDatabase } from '@/server/db/database';
import { CURRENT_SCHEMA_VERSION } from '@/server/db/migrations';
import { openContainerDatabase } from '@/server/workspace/container-runtime';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const directories:string[]=[];
afterEach(async()=>{await Promise.all(directories.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
async function scratch(){const path=await mkdtemp(join(tmpdir(),'moneywave-container-synthetic-'));directories.push(path);return path;}
describe('container key and shared store boundary',()=>{
  it('restricts the host query channel to reads, workspace writes and transaction boundaries',async()=>{
    const {allowedQuery}=await import(pathToFileURL(resolve('scripts/stage-supervisor.mjs')).href);
    expect(allowedQuery('get','SELECT * FROM accounts')).toBe(true);
    expect(allowedQuery('run','UPDATE workspace_state SET revision=? WHERE id=1')).toBe(true);
    expect(allowedQuery('run','INSERT INTO workspace_history(revision) VALUES(?)')).toBe(true);
    expect(allowedQuery('exec','BEGIN IMMEDIATE')).toBe(true);
    for(const sql of ['UPDATE ledger_entries SET amount_minor=0','DELETE FROM workspace_state','ATTACH DATABASE x AS other','PRAGMA writable_schema=ON'])for(const method of ['run','exec'])expect(allowedQuery(method,sql)).toBe(false);
  });
  it('never creates a missing database or upgrades an incompatible schema',async()=>{
    const path=join(await scratch(),'synthetic.db'),key=randomBytes(32);
    await expect(openContainerDatabase(path,key)).rejects.toThrow('STAGE_DATABASE_MISSING');
    expect(await stat(path).catch(()=>null)).toBeNull();
    const db=await openEncryptedDatabase(path,key);await db.exec('CREATE TABLE synthetic(value TEXT); PRAGMA user_version=1');await db.close();
    await expect(openContainerDatabase(path,key)).rejects.toThrow('STAGE_SCHEMA_MISMATCH');
    const unchanged=await openEncryptedDatabase(path,key);expect((await unchanged.get<{user_version:number}>('PRAGMA user_version'))?.user_version).toBe(1);await unchanged.close();
  });
  it('keeps the existing journal mode when opening the native host store',async()=>{
    const path=join(await scratch(),'synthetic.db'),key=randomBytes(32),db=await openEncryptedDatabase(path,key);
    await db.exec(`CREATE TABLE synthetic(value TEXT); PRAGMA user_version=${CURRENT_SCHEMA_VERSION}`);await db.close();
    const opened=await openContainerDatabase(path,key);await opened.exec('PRAGMA journal_mode=WAL');await opened.close();
    const retained=await openContainerDatabase(path,key);expect((await retained.get<{journal_mode:string}>('PRAGMA journal_mode'))?.journal_mode).toBe('wal');await retained.close();
  });
});

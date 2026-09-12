import { lstat } from 'node:fs/promises';
import { openEncryptedDatabase } from '@/server/db/database';
import { CURRENT_SCHEMA_VERSION } from '@/server/db/migrations';

/** The stage may open an existing compatible store; deployment never migrates it. */
export async function openContainerDatabase(path:string,key:Buffer){
  const file=await lstat(path).catch(()=>null);
  if(!file?.isFile()||file.size===0)throw new Error('STAGE_DATABASE_MISSING');
  const database=await openEncryptedDatabase(path,key);
  try{
    const version=await database.get<{user_version:number}>('PRAGMA user_version');
    if(version?.user_version!==CURRENT_SCHEMA_VERSION)throw new Error('STAGE_SCHEMA_MISMATCH');
    return database;
  }catch(error){await database.close();throw error;}
}

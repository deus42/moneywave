import { serialize, deserialize } from 'node:v8';
import { createInterface } from 'node:readline';
import type { EncryptedDatabase, SqlParameter, RunResult } from './database';

/** Docker attach is a local, unlogged pipe to the macOS SQLCipher owner. */
export async function connectHostDatabase():Promise<EncryptedDatabase>{
  const pending=new Map<number,{resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();let nextId=0,closed=false;
  let ready!:()=>void;const connected=new Promise<void>(resolve=>{ready=resolve;});
  const lines=createInterface({input:process.stdin});
  lines.on('line',line=>{
    if(line.length>16*1024*1024){process.exit(1);return;}
    try{
      const message=deserialize(Buffer.from(line,'base64'));
      if(message.ready===true){ready();return;}
      const request=pending.get(message.id);if(!request)return;pending.delete(message.id);clearTimeout(request.timer);
      if(message.error)request.reject(Object.assign(new Error('HOST_DATABASE_QUERY_FAILED'),{code:message.error}));else request.resolve(message.value);
    }catch{console.error('STAGE_DATABASE_PROTOCOL_FAILED');process.exit(1);}
  });
  function call(method:string,sql='',parameters:readonly SqlParameter[]=[]):Promise<unknown>{
    if(closed)return Promise.reject(new Error('DB_CLOSED'));
    const id=++nextId;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{pending.delete(id);reject(new Error('HOST_DATABASE_TIMEOUT'));console.error('STAGE_DATABASE_DISCONNECTED');process.exit(1);},15000);
      pending.set(id,{resolve,reject,timer});process.stdout.write(serialize({id,method,sql,parameters}).toString('base64')+'\n');
    });
  }
  await connected;
  const heartbeat=setInterval(()=>{void call('ping').catch(()=>undefined);},5000);heartbeat.unref();
  const database:EncryptedDatabase={
    path:'host:moneywave.db',
    run:(sql,parameters)=>call('run',sql,parameters) as Promise<RunResult>,
    get:<T>(sql:string,parameters?:readonly SqlParameter[])=>call('get',sql,parameters) as Promise<T|undefined>,
    all:<T>(sql:string,parameters?:readonly SqlParameter[])=>call('all',sql,parameters) as Promise<T[]>,
    exec:async sql=>{await call('exec',sql);},
    transaction:async operation=>{await database.exec('BEGIN IMMEDIATE');try{const result=await operation();await database.exec('COMMIT');return result;}catch(error){await database.exec('ROLLBACK').catch(()=>undefined);throw error;}},
    close:async()=>{closed=true;clearInterval(heartbeat);lines.close();},
  };
  return database;
}

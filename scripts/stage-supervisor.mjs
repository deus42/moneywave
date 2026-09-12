import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { serialize, deserialize } from 'node:v8';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export function allowedQuery(method,sql){
  if(typeof sql!=='string'||sql.length>100000)return false;
  if(method==='get'||method==='all')return /^\s*(SELECT|WITH)\b/i.test(sql);
  if(method==='run')return /^\s*(INSERT\s+INTO\s+workspace_history\b|UPDATE\s+workspace_state\b)/i.test(sql);
  return method==='exec'&&/^(BEGIN IMMEDIATE|COMMIT|ROLLBACK)$/i.test(sql.trim());
}
function run(file,args){return new Promise((resolve,reject)=>{
  const child=spawn(file,args,{stdio:['ignore','pipe','ignore']}),chunks=[];let size=0;
  child.stdout.on('data',chunk=>{size+=chunk.length;if(size<=65536)chunks.push(chunk);else child.kill();});
  child.once('error',reject);child.once('close',code=>{const value=Buffer.concat(chunks);for(const chunk of chunks)chunk.fill(0);if(code===0)resolve(value);else reject(new Error('COMMAND_FAILED'));});
});}
export async function supervise(config){
  const sqlite=createRequire(import.meta.url)(config.driverEntry);
  const docker=args=>run('/opt/homebrew/bin/docker',['--context',config.context,...args]);
  let stopping=false,last='',lastColimaAttempt=0,attached;
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{stopping=true;attached?.kill('SIGTERM');});
  while(!stopping){
    let db;
    try{
      try{await docker(['info','--format','{{.ServerVersion}}']);}catch{
        if(Date.now()-lastColimaAttempt>60000){lastColimaAttempt=Date.now();await run('/opt/homebrew/bin/colima',['start']);}else throw new Error();
      }
      if((await docker(['inspect','--format','{{.State.Running}}',config.name])).toString().trim()!=='true')await docker(['start',config.name]);
      const key=await run(config.keychainHelper,['get',config.keychainService,'database-key']);
      const exec=sql=>new Promise((resolve,reject)=>db.exec(sql,error=>error?reject(error):resolve()));
      const query=(method,sql,params=[])=>new Promise((resolve,reject)=>{
        db[method](sql,params,function(error,value){if(error)reject(error);else resolve(method==='run'?{lastId:this.lastID,changes:this.changes}:value);});
      });
      try{
        if(key.length!==32)throw new Error();
        db=await new Promise((resolve,reject)=>{const connection=new sqlite.Database(config.dataRoot+'/moneywave.db',sqlite.OPEN_READWRITE,error=>error?reject(error):resolve(connection));});
        await exec(`PRAGMA key = "x'${key.toString('hex')}'"`);
        await query('get','SELECT count(*) FROM sqlite_master');
        if(!(await query('get','PRAGMA cipher_version'))?.cipher_version)throw new Error();
        if((await query('get','PRAGMA user_version'))?.user_version!==config.schemaVersion)throw new Error();
        await exec('PRAGMA cipher_memory_security=ON; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5000');
      }finally{key.fill(0);}
      attached=spawn('/opt/homebrew/bin/docker',['--context',config.context,'attach','--sig-proxy=false',config.name],{stdio:['pipe','pipe','pipe']});
      attached.stderr.resume();attached.stdin.on('error',()=>{});
      const exited=new Promise(resolve=>{attached.once('error',resolve);attached.once('close',resolve);});
      const send=value=>attached.stdin.write(serialize(value).toString('base64')+'\n');
      const lines=createInterface({input:attached.stdout});
      // Repeated readiness also covers attach during container initialization.
      const greeting=setInterval(()=>send({ready:true}),1000);send({ready:true});
      if(last!=='READY'){console.log('STAGE_DATABASE_CONNECTED');last='READY';}
      try{
        for await(const line of lines){
          if(line.length>16*1024*1024)throw new Error();
          const message=deserialize(Buffer.from(line,'base64'));
          if(!Number.isSafeInteger(message.id)||message.id<1)throw new Error();
          if(message.method==='ping'){send({id:message.id});continue;}
          if(!allowedQuery(message.method,message.sql)||!Array.isArray(message.parameters)||message.parameters.some(p=>p!==null&&!Buffer.isBuffer(p)&&!['string','number'].includes(typeof p))){send({id:message.id,error:'STAGE_QUERY_DENIED'});continue;}
          try{
            const read=message.method==='get'||message.method==='all';let value;
            if(read)await exec('PRAGMA query_only=ON');
            try{value=message.method==='exec'?await exec(message.sql):await query(message.method,message.sql,message.parameters);}finally{if(read)await exec('PRAGMA query_only=OFF');}
            send({id:message.id,value});
          }catch(error){send({id:message.id,error:/^SQLITE_[A-Z_]+$/.test(error.code??'')?error.code:'STAGE_QUERY_FAILED'});}
        }
      }finally{clearInterval(greeting);lines.close();attached.kill('SIGTERM');await exited;}
    }catch{if(last!=='WAITING'){console.error('STAGE_DATABASE_WAITING');last='WAITING';}}
    finally{if(db){await new Promise(resolve=>db.exec('ROLLBACK',()=>resolve()));await new Promise(resolve=>db.close(()=>resolve()));}attached=undefined;}
    if(!stopping)await delay(3000);
  }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const config=JSON.parse(await readFile(process.argv[2],'utf8'));
  await supervise(config);
}

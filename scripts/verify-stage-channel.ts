import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

export async function stopBroker(child:ChildProcess){
  if(child.exitCode!==null||child.signalCode!==null)return;
  await new Promise<void>(resolve=>{const timer=setTimeout(()=>child.kill('SIGKILL'),5000);child.once('close',()=>{clearTimeout(timer);resolve();});child.kill('SIGTERM');});
}
export async function verifyStageChannel(input:{image:string;context:string;root:string;driverEntry:string;supervisorPath:string}){
  const {openEncryptedDatabase}=await import('../src/server/db/database');
  const {applyMigrations,CURRENT_SCHEMA_VERSION}=await import('../src/server/db/migrations');
  const {ledgerFingerprint,WorkspaceStore}=await import('../src/server/workspace/store');
  const {reportSchema}=await import('../src/server/workspace/model');
  const name='moneywave-channel-'+randomUUID().slice(0,8),directory=join(input.root,'channel-checks',name);
  await mkdir(directory,{recursive:true,mode:0o700});
  const database=await openEncryptedDatabase(join(directory,'moneywave.db'),Buffer.alloc(32,73));
  let broker:ChildProcess|undefined,created=false;
  const run=(args:string[])=>new Promise<string>((resolve,reject)=>{
    const child=spawn('/opt/homebrew/bin/docker',['--context',input.context,...args],{stdio:['ignore','pipe','pipe']});let output='',diagnostic='';child.stdout.on('data',chunk=>output+=chunk.toString());child.stderr.on('data',chunk=>{diagnostic=(diagnostic+chunk.toString()).slice(-1500);});child.on('error',reject);child.on('close',code=>{if(code===0)resolve(output.trim());else reject(new Error(`STAGE_SYNTHETIC_COMMAND_FAILED ${args[0]}: ${diagnostic.trim()}`));});
  });
  const origin='https://synthetic.example.ts.net',identity={Host:'synthetic.example.ts.net','Tailscale-User-Login':'synthetic@example.invalid'};
  let port=0;
  function call(path:string,headers:Record<string,string>={},body?:unknown){return new Promise<{status:number;body:string;cookie:string}>((resolve,reject)=>{
    const req=request({hostname:'127.0.0.1',port,path,method:body?'POST':'GET',headers:{...identity,...headers}},res=>{let text='';res.on('data',chunk=>text+=chunk.toString());res.on('end',()=>resolve({status:res.statusCode??0,body:text,cookie:res.headers['set-cookie']?.[0]?.split(';')[0]??''}));});req.setTimeout(12000,()=>req.destroy());req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
  });}
  async function ready(){for(let i=0;i<30;i++){if((await call('/healthz').catch(()=>null))?.status===200)return;await delay(1000);}throw new Error('STAGE_SYNTHETIC_NOT_READY');}
  try{
    await applyMigrations(database);const store=new WorkspaceStore(database),fingerprint=await ledgerFingerprint(database);
    await store.seed(reportSchema.parse({version:1,coverage:{start:'2090-01-01',end:'2090-01-31',generatedAt:'2090-02-01'},ledgerDigest:fingerprint,sources:[],rows:[],months:[{month:'2090-01',income:10000,tax:0,bank:0,fx:0,netSpending:0,grossSpending:0,partial:false}],plan:{SYNTHETIC:1000},collections:[]}));
    const helper=join(directory,'synthetic-helper');await writeFile(helper,`#!${process.execPath}\nprocess.stdout.write(Buffer.alloc(32,73));\n`,{mode:0o700});
    const config=join(directory,'config.json');await writeFile(config,JSON.stringify({context:input.context,name,dataRoot:directory,keychainHelper:helper,keychainService:'synthetic',driverEntry:input.driverEntry,schemaVersion:CURRENT_SCHEMA_VERSION}),{mode:0o600});
    await run(['run','-di','--name',name,'--network','moneywave-stage','--publish','127.0.0.1::43822','--log-driver','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--tmpfs','/tmp:rw,noexec,nosuid,size=64m,mode=1777','--env',`MONEYWAVE_TAILSCALE_ORIGIN=${origin}`,'--env',`MONEYWAVE_TAILSCALE_LOGIN=${identity['Tailscale-User-Login']}`,'--env','MONEYWAVE_PROXY_ADDRESS=172.30.87.1',input.image]);created=true;
    port=Number(await run(['inspect','--format','{{(index (index .NetworkSettings.Ports "43822/tcp") 0).HostPort}}',name]));
    broker=spawn(process.execPath,[input.supervisorPath,config],{stdio:['ignore','ignore','ignore']});await ready();
    await run(['exec',name,'node','scripts/stage-health.mjs']);
    const landing=await call('/'),workspace=JSON.parse((await call('/api/workspace',{Cookie:landing.cookie})).body);
    const headers={Cookie:landing.cookie,Origin:origin,'Content-Type':'application/json','X-Moneywave-Csrf':workspace.csrf};
    if((await call('/api/change',headers,{action:'budget',revision:0,category:'SYNTHETIC',from:'2090-01',amount:4200})).status!==200)throw new Error('STAGE_SYNTHETIC_WRITE_FAILED');
    if((await store.read()).state.budgets.find(b=>b.category==='SYNTHETIC')?.amount!==4200)throw new Error('STAGE_HOST_READBACK_FAILED');
    await database.exec('BEGIN IMMEDIATE');
    try{if((await call('/api/change',headers,{action:'budget',revision:1,category:'SYNTHETIC',from:'2090-01',amount:9900})).status!==400)throw new Error('STAGE_NATIVE_LOCK_FAILED');}finally{await database.exec('ROLLBACK');}
    if((await store.read()).revision!==1)throw new Error('STAGE_FAILED_WRITE_PERSISTED');
    await store.mutate({action:'budget',revision:1,category:'SYNTHETIC',from:'2090-01',amount:4300});
    await run(['restart',name]);
    port=Number(await run(['inspect','--format','{{(index (index .NetworkSettings.Ports "43822/tcp") 0).HostPort}}',name]));
    await ready();
    const renewed=await call('/'),after=JSON.parse((await call('/api/workspace',{Cookie:renewed.cookie})).body);
    if(after.revision!==2||after.state.budgets.find((b:{category:string;amount:number})=>b.category==='SYNTHETIC')?.amount!==4300)throw new Error('STAGE_RESTART_READBACK_FAILED');
    if(await ledgerFingerprint(database)!==fingerprint)throw new Error('STAGE_SYNTHETIC_LEDGER_CHANGED');
  }finally{if(broker)await stopBroker(broker);if(created){await run(['stop',name]);await run(['rm',name]);}await database.close();await rm(directory,{recursive:true,force:true});}
}

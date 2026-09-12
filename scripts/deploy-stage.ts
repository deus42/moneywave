import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { createVerifiedBackup } from '../src/server/db/backup';
import { openContainerDatabase } from '../src/server/workspace/container-runtime';
import { MacKeychainStore } from '../src/server/secrets/keychain-store';
import { CURRENT_SCHEMA_VERSION } from '../src/server/db/migrations';
import { stopBroker, verifyStageChannel } from './verify-stage-channel';

const repo=resolve(process.env.MONEYWAVE_RELEASE_SOURCE??process.cwd()),root=resolve('data/runtime/hosting/container'),configPath=join(root,'config.json');
const runtimeSchema=z.object({image:z.string(),release:z.string(),driverEntry:z.string(),supervisorPath:z.string(),schemaVersion:z.number()});
const configSchema=z.object({origin:z.url(),login:z.string().min(1),context:z.literal('colima'),name:z.literal('moneywave-stage'),dataRoot:z.string(),keychainHelper:z.string(),keychainService:z.string(),image:z.string().optional(),previousImage:z.string().optional(),previousRuntime:runtimeSchema.optional(),release:z.string().optional(),driverEntry:z.string().optional(),supervisorPath:z.string().optional(),schemaVersion:z.number().optional()});
const config=configSchema.parse(JSON.parse(await readFile(configPath,'utf8')));
const network='moneywave-stage',gateway='172.30.87.1',label='local.moneywave.stage',domain=`gui/${process.getuid!()}`;
const plistPath=join(homedir(),'Library/LaunchAgents',label+'.plist');
const secretStore=new MacKeychainStore({helperPath:config.keychainHelper,service:config.keychainService});
function run(file:string,args:string[],options:{input?:Buffer;inherit?:boolean}={}):Promise<Buffer>{return new Promise((resolve,reject)=>{
  const child=spawn(file,args,{cwd:repo,stdio:['pipe',options.inherit?'inherit':'pipe',options.inherit?'inherit':'pipe']}),chunks:Buffer[]=[];let size=0;
  child.stdout?.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size<16*1024*1024)chunks.push(chunk);else child.kill();});child.stderr?.resume();
  child.once('error',()=>reject(new Error('STAGE_COMMAND_START_FAILED')));child.once('close',code=>code===0?resolve(Buffer.concat(chunks)):reject(new Error('STAGE_COMMAND_FAILED')));
  child.stdin!.on('error',()=>{});child.stdin!.end(options.input);
});}
const docker=(args:string[],input?:Buffer)=>run('/opt/homebrew/bin/docker',['--context',config.context,...args],{input});
const exists=async(path:string)=>Boolean(await stat(path).catch(()=>null));
const hash=async(path:string)=>createHash('sha256').update(await readFile(path)).digest('hex');
function probe(port:number,path:string,cookie?:string){return new Promise<{status:number;body:Buffer;cookie:string}>((resolve,reject)=>{
  const req=request({hostname:'127.0.0.1',port,path,headers:{Host:new URL(config.origin).host,'Tailscale-User-Login':config.login,...(cookie?{Cookie:cookie}:{})}},res=>{
    const chunks:Buffer[]=[];res.on('data',chunk=>chunks.push(Buffer.from(chunk)));res.on('end',()=>resolve({status:res.statusCode??0,body:Buffer.concat(chunks),cookie:res.headers['set-cookie']?.[0]?.split(';')[0]??''}));
  });req.setTimeout(5000,()=>req.destroy());req.on('error',reject);req.end();
});}
async function ready(port:number){for(let n=0;n<30;n++){const result=await probe(port,'/healthz').catch(()=>null);if(result?.status===200)return;await delay(1000);}throw new Error('STAGE_NOT_READY');}
async function owned(name:string){const value=await docker(['inspect','--format','{{index .Config.Labels "local.moneywave.stage"}}',name]).catch(()=>null);if(value&&value.toString().trim()!=='true')throw new Error('STAGE_CONTAINER_NOT_OWNED');return Boolean(value);}
async function removeOwned(name:string){if(await owned(name)){await docker(['stop','--time','20',name]);await docker(['rm',name]);}}
async function ensureNetwork(){
  const found=await docker(['network','inspect',network]).catch(()=>null);
  if(found){const [item]=JSON.parse(found.toString());if(item.Internal||item.Labels?.['local.moneywave.stage']!=='true'||item.IPAM.Config[0]?.Gateway!==gateway||item.Options?.['com.docker.network.bridge.enable_ip_masquerade']!=='false'||item.Options?.['com.docker.network.bridge.enable_icc']!=='false')throw new Error('STAGE_NETWORK_CONFLICT');}
  else await docker(['network','create','--subnet','172.30.87.0/24','--gateway',gateway,'--opt','com.docker.network.bridge.enable_ip_masquerade=false','--opt','com.docker.network.bridge.enable_icc=false','--label','local.moneywave.stage=true',network]);
}
async function createContainer(name:string,image:string,port:number,release:string,restart:boolean){
  const metadata=await stat(join(config.dataRoot,'moneywave.db')),uid=String(metadata.uid),gid=String(metadata.gid);
  await docker(['run','-di','--name',name,'--label','local.moneywave.stage=true','--network',network,
    '--publish',`127.0.0.1:${port}:43822`,'--restart',restart?'unless-stopped':'no','--init','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges',
    '--user',`${uid}:${gid}`,'--memory','768m','--memory-swap','768m','--pids-limit','128',
    '--tmpfs',`/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777,uid=${uid},gid=${gid}`,
    '--env',`MONEYWAVE_TAILSCALE_ORIGIN=${config.origin}`,'--env',`MONEYWAVE_TAILSCALE_LOGIN=${config.login}`,'--env',`MONEYWAVE_PROXY_ADDRESS=${gateway}`,'--env',`MONEYWAVE_RELEASE_ID=${release}`,
    '--log-driver','none',image]);
}
async function acceptance(port:number){
  const landing=await probe(port,'/');if(landing.status!==200||!landing.cookie)throw new Error('STAGE_HTML_FAILED');
  for(const asset of ['index.html','app.js','navigation.js','privacy.js','style.css','moneywave-mark.png']){
    const response=asset==='index.html'?landing:await probe(port,'/'+asset);
    if(response.status!==200||createHash('sha256').update(response.body).digest('hex')!==await hash(join(repo,'src/web',asset)))throw new Error('STAGE_ASSET_MISMATCH');
  }
  for(const path of ['/api/workspace','/api/period?period=last12'])if((await probe(port,path,landing.cookie)).status!==200)throw new Error('STAGE_READ_FAILED');
}
async function saveConfig(){await writeFile(configPath+'.next',JSON.stringify(config,null,2)+'\n',{mode:0o600});await rename(configPath+'.next',configPath);}
async function prepareHost(release:string){
  const directory=join(root,'host-releases',release),modules=join(directory,'node_modules');await mkdir(modules,{recursive:true,mode:0o700});
  const sqlPackage=resolve('node_modules/@journeyapps/sqlcipher/package.json'),sqlRequire=createRequire(sqlPackage),bindings=sqlRequire.resolve('bindings/package.json');
  for(const [name,file] of [['@journeyapps/sqlcipher',sqlPackage],['bindings',bindings],['file-uri-to-path',createRequire(bindings).resolve('file-uri-to-path/package.json')]])await cp(dirname(file),join(modules,name),{recursive:true,dereference:true});
  config.driverEntry=join(modules,'@journeyapps/sqlcipher/lib/sqlite3.js');config.schemaVersion=CURRENT_SCHEMA_VERSION;config.supervisorPath=join(directory,'supervisor.mjs');
  await copyFile(join(repo,'scripts/stage-supervisor.mjs'),config.supervisorPath);
}
async function candidateBroker(name:string){
  const path=join(root,'candidate-config.json');await writeFile(path,JSON.stringify({...config,name}),{mode:0o600});
  return spawn(process.execPath,[config.supervisorPath!,path],{stdio:['ignore','ignore','ignore']});
}
async function installSupervisor(){
  await run('/usr/bin/python3',['-c',"import json,plistlib,sys; c=json.loads(sys.argv[1]); open(sys.argv[2],'wb').write(plistlib.dumps(c))",JSON.stringify({Label:label,ProgramArguments:['/usr/bin/caffeinate','-s','/opt/homebrew/opt/node@24/bin/node',config.supervisorPath,configPath],RunAtLoad:true,KeepAlive:true,ThrottleInterval:10,EnvironmentVariables:{PATH:'/opt/homebrew/bin:/usr/bin:/bin'},StandardOutPath:join(root,'supervisor.log'),StandardErrorPath:join(root,'supervisor.log')}),plistPath]);
  await run('/bin/launchctl',['bootout',`${domain}/${label}`]).catch(()=>undefined);
  await run('/bin/launchctl',['bootstrap',domain,plistPath]);
}

async function deploy(){
  if(process.platform!=='darwin'||new URL(config.origin).protocol!=='https:'||!new URL(config.origin).hostname.endsWith('.ts.net'))throw new Error('STAGE_HOST_INVALID');
  if(process.argv.includes('--status')){
    console.log((await docker(['inspect','--format','{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}} {{.Image}}',config.name])).toString().trim());
    console.log((await probe(43822,'/healthz')).status===200?'STAGE_HTTP_OK':'STAGE_HTTP_FAILED');return;
  }
  await mkdir(root,{recursive:true,mode:0o700});
  const rollback=process.argv.includes('--rollback');
  let image=config.previousImage,release=`stage-${new Date().toISOString().replace(/[^0-9]/g,'')}`;
  if(rollback&&!image)throw new Error('STAGE_NO_ROLLBACK_IMAGE');
  if(!rollback){
    await run('/opt/homebrew/bin/pnpm',['verify'],{inherit:true});
    image=`moneywave:${release}`;
    await run('/opt/homebrew/bin/docker',['--context',config.context,'build','-t',image,'.'],{inherit:true});
  }else release+='-rollback';
  const previousConfig={...config};
  if(rollback&&config.previousRuntime){
    const retained=config.previousRuntime;
    image=retained.image;release=retained.release;
    config.driverEntry=retained.driverEntry;config.supervisorPath=retained.supervisorPath;config.schemaVersion=retained.schemaVersion;
  }else await prepareHost(release);
  await ensureNetwork();
  await verifyStageChannel({image:image!,context:config.context,root,driverEntry:config.driverEntry!,supervisorPath:config.supervisorPath!});
  const databasePath=join(config.dataRoot,'moneywave.db'),key=await secretStore.get('database-key');
  const database=await openContainerDatabase(databasePath,key).catch(error=>{key.fill(0);throw error;});
  try{
    const tables=await database.all<{name:string}>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
    await createVerifiedBackup({database,destinationPath:join(config.dataRoot,'backups',`${release}.backup`),key,reason:'manual',requiredTables:tables.map(t=>t.name)});
  }finally{key.fill(0);await database.close();}
  const before=await hash(databasePath),serveBefore=await run('/opt/homebrew/bin/tailscale',['serve','status','--json']);
  const candidate=config.name+'-candidate';
  await removeOwned(candidate);
  let broker:ReturnType<typeof spawn>|undefined;
  try{
    await createContainer(candidate,image!,43823,release,false);
    broker=await candidateBroker(candidate);await ready(43823);
    await docker(['exec',candidate,'node','scripts/stage-health.mjs']);
    if(!rollback)await acceptance(43823);
    if(await hash(databasePath)!==before)throw new Error('STAGE_DATA_CHANGED_DURING_CHECK');
  }finally{if(broker)await stopBroker(broker);await removeOwned(candidate);}
  const previous=config.image;
  const legacy=join(homedir(),'Library/LaunchAgents/local.moneywave.stable.plist');
  if(await exists(legacy)&&!await exists(join(root,'legacy.plist')))await copyFile(legacy,join(root,'legacy.plist'));
  await run('/bin/launchctl',['bootout',`${domain}/${label}`]).catch(()=>undefined);
  await run('/bin/launchctl',['bootout',`${domain}/local.moneywave.stable`]).catch(()=>undefined);
  await removeOwned(config.name);
  try{
    await createContainer(config.name,image!,43822,release,true);
    await saveConfig();
    await installSupervisor();await ready(43822);
    await docker(['exec',config.name,'node','scripts/stage-health.mjs']);
    if(!rollback)await acceptance(43822);
    if(await hash(databasePath)!==before)throw new Error('STAGE_DATA_CHANGED_DURING_CHECK');
    if(!(await run('/opt/homebrew/bin/tailscale',['serve','status','--json'])).equals(serveBefore))throw new Error('STAGE_SERVE_CHANGED');
    const previousRuntime=runtimeSchema.safeParse(previousConfig);
    config.previousRuntime=previousRuntime.success?previousRuntime.data:undefined;
    config.previousImage=previous;config.image=image;config.release=release;
    await saveConfig();
    await run('/bin/launchctl',['disable',`${domain}/local.moneywave.stable`]);
    console.log(`STAGE_READY ${config.origin}/`);
  }catch(error){
    await run('/bin/launchctl',['bootout',`${domain}/${label}`]).catch(()=>undefined);
    await removeOwned(config.name);
    for(const field of Object.keys(config))delete (config as Record<string,unknown>)[field];
    Object.assign(config,previousConfig);await saveConfig();
    if(previous){await createContainer(config.name,previous,43822,'rollback',true);await installSupervisor();await ready(43822);}
    else if(await exists(join(root,'legacy.plist'))){await run('/bin/launchctl',['enable',`${domain}/local.moneywave.stable`]);await run('/bin/launchctl',['bootstrap',domain,join(root,'legacy.plist')]);}
    throw error;
  }
}
async function main(){
  if(process.argv.includes('--status'))return deploy();
  const lock=join(root,'deploy.lock');
  await mkdir(root,{recursive:true,mode:0o700});
  await mkdir(lock,{mode:0o700}).catch(()=>{throw new Error('STAGE_DEPLOY_ALREADY_RUNNING');});
  try{await writeFile(join(lock,'pid'),String(process.pid),{mode:0o600});await deploy();}finally{await rm(lock,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error instanceof Error?error.message:'STAGE_FAILED');process.exitCode=1;});

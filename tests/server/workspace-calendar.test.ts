import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { openEncryptedDatabase } from '@/server/db/database';
import { applyMigrations } from '@/server/db/migrations';
import { FinanceCenters } from '@/server/read-model/finance-centers';
import { WorkspaceStore } from '@/server/workspace/store';
import { createWorkspaceServer } from '@/server/workspace/http';
import { collectionSchema, reportSchema } from '@/server/workspace/model';

it('exposes historical collection months to the shared picker without adding cashflow coverage',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'moneywave-calendar-synthetic-'));
 const db=await openEncryptedDatabase(join(directory,'test.db'),Buffer.alloc(32,84));
 await applyMigrations(db);
 const now=()=>new Date('2090-04-01T00:00:00Z'),store=new WorkspaceStore(db,now);
 const report=reportSchema.parse({version:2,coverage:{start:'2090-03-01',end:'2090-03-31',generatedAt:'2090-04-01'},ledgerDigest:'synthetic',sources:[],collections:[],rows:[],plan:{Books:1000},
  months:[{month:'2090-03',income:5000,tax:0,bank:0,grossSpending:0,netSpending:0,partial:false,fx:0}]});
 await store.seed(report);
 const trip=collectionSchema.parse({id:'synthetic-history',name:'SYNTHETIC historical trip',kind:'trip',start:'2088-12-28',end:'2089-01-04',budget:null,rowIds:[],payments:[{id:'synthetic-manual',date:'2088-12',eur:500,reportingScope:'trip_only',description:'SYNTHETIC historical evidence'}]});
 await store.mutate({action:'collection',revision:0,collection:trip});
 const before=await store.read();
 const server=createWorkspaceServer({store,centers:new FinanceCenters(db,now),sourceCurrent:true,staticDirectory:resolve('src/web'),now});
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
 const address=server.address();if(!address||typeof address==='string')throw new Error('NO_ADDRESS');
 const origin=`http://127.0.0.1:${address.port}`;
 try{
  const landing=await fetch(origin),headers={Cookie:landing.headers.get('set-cookie')!.split(';')[0]};
  const workspace=await(await fetch(origin+'/api/workspace',{headers})).json();
  expect(workspace.calendar.months).toEqual(['2088-12','2089-01','2090-03']);
  expect(workspace.report.months).toEqual(report.months);
  expect(workspace.statementCoverage).toEqual(report.coverage);
  for(const period of ['2088','2088-12','2089','2089-01']){
   const response=await fetch(origin+`/api/period?period=${period}`,{headers});expect(response.status).toBe(200);
   expect(await response.json()).toMatchObject({period,months:[],availableRange:null,rows:[],plan:0,fx:null,comparison:null});
  }
  expect((await fetch(origin+'/api/period?period=2089-02',{headers})).status).toBe(400);
  const all=await(await fetch(origin+'/api/period?period=all',{headers})).json();
  expect(all).toMatchObject({range:{from:trip.start,to:report.coverage.end},income:5000,net:0,plan:1000,months:report.months});
  const savings=await(await fetch(origin+'/api/savings?period=2088-12',{headers})).json();
  expect(savings).toMatchObject({from:null,to:null,bridge:null,months:[]});
  expect(await store.read()).toEqual(before);
  await store.mutate({action:'deleteCollection',revision:1,id:trip.id});
  const after=await(await fetch(origin+'/api/workspace',{headers})).json();
  expect(after.calendar.months).toEqual(['2090-03']);
 }finally{await new Promise<void>(done=>server.close(()=>done()));await db.close();await rm(directory,{recursive:true,force:true});}
});

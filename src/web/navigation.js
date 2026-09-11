/** Only opaque stamps enter browser history. Filters and record references stay in memory. */
export function createNavigation({history,listen,capture,restore,fallback,url,dirty,confirm,changed}) {
 const snapshots=new Map(),positions=new Map();
 let current=null,applying=0,revision=0,reverting=null,forceNext=false;
 const valid=s=>s&&s.kind==='moneywave-navigation-v1'&&typeof s.scope==='string'&&typeof s.id==='string'&&Number.isSafeInteger(s.index)&&s.index>=0;
 const cache=()=>{if(current&&!applying)snapshots.set(current.id,structuredClone(capture()));};
 const remember=()=>{if(!current||applying||reverting)return;cache();history.replaceState(current,'',url(capture()));};
 const apply=(stamp,snapshot)=>{
  current=stamp;positions.set(stamp.index,stamp.id);snapshots.set(stamp.id,structuredClone(snapshot));
  const token=++revision;applying=token;changed();
  const finish=()=>{if(applying===token){applying=0;changed();}};
  try {const result=restore(structuredClone(snapshot));if(result?.then)return result.finally(finish);finish();}
  catch(error){finish();throw error;}
 };
 function visit(snapshot,force=false) {
  if(!force&&dirty()){confirm(()=>visit(snapshot,true));return;}
  remember();
  const stamp={kind:'moneywave-navigation-v1',scope:current.scope,id:crypto.randomUUID(),index:current.index+1};
  for(const [index,id] of positions)if(index>=stamp.index){positions.delete(index);snapshots.delete(id);}
  history.pushState(stamp,'',url(snapshot));return apply(stamp,snapshot);
 }
 listen(event=>{
  const target=event.state;
  if(!valid(target)||target.scope!==current?.scope)return;
  if(reverting){
   if(target.id===current.id){const blocked=reverting;reverting=null;confirm(()=>{forceNext=true;history.go(blocked.index-current.index);});}
   return;
  }
  cache();
  if(!forceNext&&dirty()&&target.index!==current.index){reverting=target;history.go(current.index-target.index);return;}
  forceNext=false;
  return apply(target,snapshots.get(target.id)??fallback());
 });
 return {
  start(snapshot){
   current=valid(history.state)?history.state:{kind:'moneywave-navigation-v1',scope:crypto.randomUUID(),id:crypto.randomUUID(),index:0};
   positions.set(current.index,current.id);snapshots.set(current.id,structuredClone(snapshot));history.replaceState(current,'',url(snapshot));changed();
  },
  visit,remember,
  back(force=false){if(current?.index>0){forceNext=force;history.back();}},
  forward(){history.forward();},
  canBack:()=>Boolean(current&&current.index>0),
  canForward:()=>positions.has(current?.index+1),
  previous:()=>snapshots.get(positions.get(current?.index-1)),
 };
}

import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {describe,it,expect} from 'vitest';

type Snapshot={page:string;period:string;category?:string;query?:string;scroll?:number;panel?:{type:string;id:string}|null};
type Stamp={kind:string;scope:string;id:string;index:number};
type Options={history:HistoryDouble;listen:(f:(e:{state:Stamp})=>void)=>void;capture:()=>Snapshot;restore:(s:Snapshot)=>void;fallback:()=>Snapshot;url:(s:Snapshot)=>string;dirty:()=>boolean;confirm:(resume:()=>void)=>void;changed:()=>void};
type Navigation={start:(s:Snapshot)=>void;visit:(s:Snapshot,force?:boolean)=>void;remember:()=>void;back:(force?:boolean)=>void;forward:()=>void;canBack:()=>boolean;canForward:()=>boolean;previous:()=>Snapshot|undefined};
class HistoryDouble {
 entries:{state:Stamp;url:string}[]=[];position=-1;listeners:((e:{state:Stamp})=>void)[]=[];
 get state(){return this.entries[this.position]?.state;}
 replaceState(state:Stamp,_unused:string,url:string){if(this.position<0){this.position=0;this.entries.push({state,url});}else this.entries[this.position]={state,url};}
 pushState(state:Stamp,_unused:string,url:string){this.entries.splice(this.position+1);this.entries.push({state,url});this.position++;}
 go(delta:number){const next=this.position+delta;if(next<0||next>=this.entries.length)return;this.position=next;for(const listener of this.listeners)listener({state:this.state});}
 back(){this.go(-1);}forward(){this.go(1);}
}
function setup(history=new HistoryDouble()){
 const source=readFileSync('src/web/navigation.js','utf8').replace('export function createNavigation','function createNavigation');
 const factory=runInNewContext(source+'\ncreateNavigation',{crypto,structuredClone}) as (o:Options)=>Navigation;
 let current:Snapshot={page:history.state?new URL('http://synthetic'+history.entries[history.position].url).searchParams.get('page')!:'budget',period:'2090',scroll:400},dirty=false,resume:(()=>void)|undefined;
 const navigation=factory({history,listen:f=>history.listeners.push(f),capture:()=>structuredClone(current),restore:s=>{current=s;},fallback:()=>({page:new URL('http://synthetic'+history.entries[history.position].url).searchParams.get('page')!,period:'2090'}),url:s=>'?'+new URLSearchParams({page:s.page,period:s.period}),dirty:()=>dirty,confirm:fn=>{resume=fn;},changed:()=>{}});
 navigation.start(current);
 return {history,navigation,get current(){return current;},edit:(s:Partial<Snapshot>)=>{current={...current,...s};},setDirty:(value:boolean)=>{dirty=value;},confirm:()=>{dirty=false;resume?.();}};
}
describe('private in-memory navigation with browser history',()=>{
 it('returns from operation detail to filtered transactions and then the original scrolled budget',()=>{
  const t=setup();t.navigation.visit({page:'transactions',period:'2090',category:'SYNTHETIC gifts',query:'',scroll:0});
  t.edit({query:'SYNTHETIC private merchant',scroll:160});t.navigation.remember();
  t.navigation.visit({...t.current,panel:{type:'row',id:'synthetic-id'}});
  t.navigation.back();expect(t.current).toMatchObject({page:'transactions',category:'SYNTHETIC gifts',query:'SYNTHETIC private merchant',scroll:160});
  t.navigation.back();expect(t.navigation.canForward()).toBe(true);expect(t.current).toEqual({page:'budget',period:'2090',scroll:400});
  t.navigation.forward();t.navigation.forward();expect(t.current.panel?.id).toBe('synthetic-id');
 });
 it('stores only opaque navigation stamps and safe route URLs in browser history',()=>{
  const t=setup();t.navigation.visit({page:'transactions',period:'2090',category:'SYNTHETIC sensitive category',query:'SYNTHETIC private description',panel:{type:'row',id:'synthetic-private-id'}});
  const persisted=JSON.stringify(t.history.entries);expect(persisted).not.toMatch(/sensitive|private|description|category|panel/);expect(t.history.entries).toHaveLength(2);
  t.edit({query:'changed query'});t.navigation.remember();t.navigation.remember();expect(t.history.entries).toHaveLength(2);
 });
 it('bounces browser Back when an edit is dirty and continues only after explicit discard',()=>{
  const t=setup();t.navigation.visit({page:'transactions',period:'2090',panel:{type:'row',id:'synthetic-row'}});t.setDirty(true);
  t.history.back();expect(t.history.position).toBe(1);expect(t.current.panel?.id).toBe('synthetic-row');
  t.confirm();expect(t.history.position).toBe(0);expect(t.current.page).toBe('budget');
 });
 it('guards explicit navigation, supports forced close after save, and cuts stale forward branches',()=>{
  const t=setup();t.setDirty(true);t.navigation.visit({page:'transactions',period:'2090'});expect(t.current.page).toBe('budget');t.confirm();expect(t.current.page).toBe('transactions');
  t.setDirty(true);t.navigation.back(true);expect(t.current.page).toBe('budget');t.setDirty(false);
  t.navigation.visit({page:'events',period:'2090'});t.navigation.forward();expect(t.current.page).toBe('events');expect(t.history.entries).toHaveLength(2);expect(t.navigation.canForward()).toBe(false);
 });
 it('falls back to the safe page URL after a document reload without persisting private filters',()=>{
  const first=setup();first.navigation.visit({page:'transactions',period:'2090',category:'SYNTHETIC private'});first.history.listeners=[];
  const next=setup(first.history);expect(next.navigation.canBack()).toBe(true);next.navigation.back();expect(next.current.page).toBe('budget');next.navigation.forward();expect(next.current.category).toBeUndefined();
 });
});

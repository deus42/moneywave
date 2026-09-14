import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {describe,expect,it} from 'vitest';

type Collection={id:string;name:string;kind:'trip'|'event'|'purchase';start:string;end:string;note:string;dateLabel?:string;datePrecision?:'day'|'month'|'year'};
const source=readFileSync('src/web/app.js','utf8');
const selection=source.slice(source.indexOf('function selectedCollections('),source.indexOf('const tripDates='));
const rendering=source.slice(source.indexOf('function tripCollections('),source.indexOf('function tripView('));
const item=(id:string,start:string,end:string,extra:Partial<Collection>={}):Collection=>({id,name:id,kind:'trip',start,end,note:'',...extra});

function page(collections:Collection[]){
 return runInNewContext(selection+rendering+'\n({selectedCollections,tripCollections})',{
  workspace:{state:{collections}},view:{range:{from:'2088-01-01',to:'2091-12-31'}},
  period:'all',allCollections:false,seasonOnly:false,collectionKind:'all',collectionQuery:'',
  totals:()=>({net:100}),euro:(value:number)=>String(value),
  heading:()=>'',collectionToolbar:()=>'',collectionSummary:()=>'',collectionEmpty:()=>'',
  tripCard:(c:Collection)=>`<article data-trip="${c.id}"></article>`,
 }) as {selectedCollections:(kind:string)=>Collection[];tripCollections:()=>string};
}

describe('trip chronology',()=>{
 it('places recently completed ranges above later-starting but older trips',()=>{
  const collections=[
   item('summer','2090-06-11','2090-06-15'),
   item('long-range','2090-02-03','2090-11-12',{dateLabel:'Оплати за кілька місяців'}),
   item('short-winter','2090-02-08','2090-02-11'),
   item('several-visits','2090-01-08','2090-03-09'),
  ];
  expect(page(collections).selectedCollections('trip').map(c=>c.id)).toEqual(['long-range','summer','several-visits','short-winter']);
  expect(collections.map(c=>c.id)).toEqual(['summer','long-range','short-winter','several-visits']);
 });

 it('uses stable start, name and id tie-breakers when periods end together',()=>{
  const collections=[
   item('b','2090-04-10','2090-05-09',{name:'Same'}),
   item('earlier-start','2090-04-02','2090-05-09'),
   item('z','2090-04-10','2090-05-09',{name:'Zed'}),
   item('a','2090-04-10','2090-05-09',{name:'Same'}),
  ];
  const expected=['a','b','z','earlier-start'];
  expect(page(collections).selectedCollections('trip').map(c=>c.id)).toEqual(expected);
  expect(page([...collections].reverse()).selectedCollections('trip').map(c=>c.id)).toEqual(expected);
 });

 it('groups a cross-year trip under its completion year in descending order',()=>{
  const html=page([
   item('previous-year','2089-11-01','2089-11-07'),
   item('cross-year','2088-12-20','2090-01-03'),
   item('latest','2090-08-01','2090-08-03'),
  ]).tripCollections();
  const groups=[...html.matchAll(/<section class="journey-year">([\s\S]*?)<\/section>/gu)].map(([,body])=>({
   year:body.match(/<h2>(\d{4})<\/h2>/u)?.[1],
   ids:[...body.matchAll(/data-trip="([^"]+)"/gu)].map(([,id])=>id),
  }));
  expect(groups).toEqual([{year:'2090',ids:['latest','cross-year']},{year:'2089',ids:['previous-year']}]);
 });

 it('sorts events and coarse ranges without parsing display labels or changing dates',()=>{
  const collections=[
   item('event','2090-05-02','2090-05-04',{kind:'event',dateLabel:'Special occasion'}),
   item('annual','2090-01-01','2090-12-31',{datePrecision:'year',dateLabel:'Year only'}),
   item('month','2090-07-01','2090-07-31',{datePrecision:'month',dateLabel:'Month only'}),
  ];
  const before=structuredClone(collections);
  expect(page(collections).selectedCollections('trip').map(c=>c.id)).toEqual(['annual','month','event']);
  expect(collections).toEqual(before);
 });

 it('preserves purchase start-date ordering and keeps trips out of purchases',()=>{
  const collections=[
   item('older-purchase','2090-02-03','2090-11-12',{kind:'purchase'}),
   item('trip','2090-10-01','2090-10-09'),
   item('newer-purchase','2090-06-11','2090-06-15',{kind:'purchase'}),
  ];
  expect(page(collections).selectedCollections('purchase').map(c=>c.id)).toEqual(['newer-purchase','older-purchase']);
 });
});

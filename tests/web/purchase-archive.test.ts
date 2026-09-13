import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {describe,expect,it} from 'vitest';
const source=readFileSync('src/web/app.js','utf8');
const selection=source.slice(source.indexOf('function selectedCollections('),source.indexOf('const tripDates='));
const collections=[
 {id:'old',name:'SYNTHETIC old item',kind:'purchase',start:'2080-01-01',end:'2080-01-01',note:'',archived:true},
 {id:'current',name:'SYNTHETIC current item',kind:'purchase',start:'2090-01-01',end:'2090-01-01',note:''},
 {id:'trip',name:'SYNTHETIC trip',kind:'trip',start:'2090-01-01',end:'2090-01-01',note:''},
];
function selected(filter='all',query='',period='all'){
 const context={workspace:{state:{collections}},view:{range:{from:'2090-01-01',to:'2090-01-31'}},collectionKind:filter,collectionQuery:query,period,seasonOnly:false,allCollections:false,purchaseLinkInfo:()=>({status:'matched'}),totals:()=>({rows:[]})};
 return runInNewContext(selection+'\nselectedCollections("purchase").map(c=>c.id)',context);
}
describe('purchase archive',()=>{
 it('keeps archived purchases out of active and transaction-status lists',()=>{expect(selected()).toEqual(['current']);expect(selected('matched')).toEqual(['current']);});
 it('keeps older purchases searchable in archive even when the selected period is recent',()=>{expect(selected('archived','','2090-01')).toEqual(['old']);expect(selected('archived','old','2090-01')).toEqual(['old']);expect(selected('archived','current')).toEqual([]);});
});

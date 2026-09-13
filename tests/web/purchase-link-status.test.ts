import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {describe,expect,it} from 'vitest';
const source=readFileSync('src/web/app.js','utf8');
const helpers=source.slice(source.indexOf('function purchaseLinkInfo('),source.indexOf('function purchaseReference('));
const selection=source.slice(source.indexOf('function selectedCollections('),source.indexOf('const tripDates='));
const esc=(v:unknown)=>String(v??'').replaceAll('<','&lt;').replaceAll('"','&quot;');
function setup(filter='all'){
 const collections=['matched','unmatched','review','cash'].map(status=>({id:status,name:'SYNTHETIC '+status,kind:'purchase',start:'2090-01-01',end:'2090-01-01',note:'',rowIds:status==='unmatched'?[]:['row']}));
 const workspace={report:{rows:[{id:'row',description:'SYNTHETIC original merchant'}]},state:{collections},purchaseLinkAudit:{links:{cash:{status:'cash',reason:'cash_confirmed',transactionCount:0},matched:{status:'matched',amountVerified:true,transactionCount:1},unmatched:{status:'unmatched',transactionCount:0,reason:'no_transaction'},review:{status:'review',reason:'amount_mismatch',transactionCount:1}},rowLinks:{row:['matched']},unmatchedRetailerRows:['unlinked']}};
 return runInNewContext(helpers+selection+'\n({purchaseLinkBadge,operationPurchaseLinks,originalOperationDescription,selectedCollections,collections:workspace.state.collections})',{workspace,esc,view:{range:{from:'2090-01-01',to:'2090-12-31'}},period:'all',seasonOnly:false,collectionKind:filter,collectionQuery:''});
}
describe('purchase matching controls',()=>{
 it('filters each matching state and displays the difference between verified and absent links',()=>{
  for(const status of ['matched','unmatched','review','cash'])expect(setup(status).selectedCollections('purchase').map((c:{id:string})=>c.id)).toEqual([status]);
  const api=setup();expect(api.purchaseLinkBadge(api.collections[0])).toContain('Транзакцію звірено');expect(api.purchaseLinkBadge(api.collections[1],true)).toContain('Банківську оплату ще не прив’язано');expect(api.purchaseLinkBadge(api.collections[3],true)).toContain('Сплачено готівкою');
 });
 it('links transactions back to purchases and flags only the audited unmatched rows',()=>{
  const api=setup();expect(api.operationPurchaseLinks({id:'row'})).toContain('data-collection="matched"');
  expect(api.operationPurchaseLinks({id:'unlinked'})).toContain('Без прив’язаної покупки');expect(api.operationPurchaseLinks({id:'unrelated'})).toBe('');
  expect(api.originalOperationDescription({id:'row',description:'SYNTHETIC updated title'})).toContain('SYNTHETIC original merchant');
 });
});

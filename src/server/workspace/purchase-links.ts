import {exactSum,type Collection,type ReportRow} from './model';

type LinkInfo={status:'matched'|'unmatched'|'review'|'cash';transactionCount:number;amountVerified:boolean;reason?:string};
/** Derive link state from current evidence; source amounts never create transactions. */
export function purchaseLinkAudit(collections:Collection[],rows:ReportRow[],originalRows:ReportRow[]=rows){
 const purchases=collections.filter(c=>c.kind==='purchase'),byId=new Map(rows.map(r=>[r.id,r])),originalById=new Map(originalRows.map(r=>[r.id,r]));
 const rowLinks:Record<string,string[]>=Object.create(null);
 const idsFor=(c:Collection)=>[...new Set([...c.rowIds,...rows.filter(r=>r.splitParentId&&r.collectionId===c.id).map(r=>r.id)])];
 for(const c of purchases)for(const id of idsFor(c)){(rowLinks[id]??=[]).push(c.id);const parent=byId.get(id)?.splitParentId;if(parent&&!rowLinks[parent]?.includes(c.id))(rowLinks[parent]??=[]).push(c.id);}
 const links:Record<string,LinkInfo>=Object.create(null);
 for(const c of purchases){
  const ids=idsFor(c),resolved=ids.flatMap(id=>byId.has(id)?[byId.get(id)!]:[]);
  const bank=resolved.filter(r=>['ledger','zen_statement','ledger_split'].includes(r.source)),debits=bank.filter(r=>(r.eur>0||r.splitParentId&&Number(r.nativeMinor)<0)&&!r.excluded);
  const info:LinkInfo={status:'matched',transactionCount:new Set(bank.map(r=>r.splitParentId??r.id)).size,amountVerified:false};
  if(resolved.length!==ids.length){info.status='review';info.reason='missing_row';}
  else if(ids.some(id=>rowLinks[id].length>1)){info.status='review';info.reason='shared_row';}
  else if(!debits.length){info.status=bank.length?'review':c.purchaseDetails?.paidInCash?'cash':'unmatched';info.reason=bank.length?'no_debit':c.purchaseDetails?.paidInCash?'cash_confirmed':'no_transaction';}
  else{
   const orders=c.purchaseDetails?.sources.filter(s=>s.kind==='amazon'&&s.status!=='replacement')??[];
   if(orders.length){
    const expected=orders.map(s=>s.amounts.find(a=>a.label==='Grand Total')?.eur);
    const actual=debits.map(r=>r.nativeEur??(r.currency==='EUR'&&r.nativeMinor!=null?Math.abs(Number(r.nativeMinor)):undefined));
    if(debits.some(r=>! /\b(?:amazon|amzn)\b/iu.test(originalById.get(r.splitParentId??r.id)?.description??''))){info.status='review';info.reason='merchant_mismatch';}
    else if(orders.some(s=>s.status==='unknown')){info.status='review';info.reason='unknown_order';}
    else if(!expected.every(v=>Number.isSafeInteger(v))||!actual.every(v=>Number.isSafeInteger(v))){info.status='review';info.reason='amount_unavailable';}
    else if(exactSum(expected as number[])!==exactSum(actual as number[])){info.status='review';info.reason='amount_mismatch';}
    else info.amountVerified=true;
   }
  }
  links[c.id]=info;
 }
 const unmatchedRetailerRows=originalRows.filter(r=>r.source==='ledger'&&r.eur>0&&!byId.get(r.id)?.excluded&&!rowLinks[r.id]?.length&&/amazon/iu.test(r.description)&&!/prime|music|audible|kindle\s*unlimited/iu.test(r.description)).map(r=>r.id);
 return {links,rowLinks,unmatchedRetailerRows};
}

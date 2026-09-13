import {z} from 'zod';
import type {ReportRow,WorkspaceReport,WorkspaceState} from './model';

const minor=z.number().int().positive().max(1e12);
export const operationSplitSchema=z.object({
 currency:z.string().regex(/^[A-Z]{3}$/u),
 note:z.string().max(2000).default(''),
 parts:z.array(z.object({
  id:z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/u),name:z.string().trim().min(1).max(240),
  amountMinor:minor,kind:z.enum(['expense','unresolved']),category:z.string().trim().min(1).max(240),
  collectionId:z.string().min(1).max(180).optional(),
 })).min(2).max(50),
}).refine(s=>new Set(s.parts.map(p=>p.id)).size===s.parts.length,'SPLIT_DUPLICATE_PART');
export type OperationSplit=z.infer<typeof operationSplitSchema>;

/** Largest remainder allocation of an existing valuation, never an inferred FX rate. */
export function allocateValuation(total:number,parts:OperationSplit['parts']):number[]{
 if(!Number.isSafeInteger(total)||total<0)throw new Error('SPLIT_AMOUNT_INVALID');
 const sum=parts.reduce((n,p)=>n+BigInt(p.amountMinor),0n);
 const allocations=parts.map((p,index)=>{const product=BigInt(total)*BigInt(p.amountMinor);return {index,id:p.id,value:product/sum,remainder:product%sum};});
 let remaining=BigInt(total)-allocations.reduce((n,p)=>n+p.value,0n);
 for(const p of [...allocations].sort((a,b)=>a.remainder===b.remainder?a.id.localeCompare(b.id):a.remainder>b.remainder?-1:1)){
  if(remaining===0n)break;p.value++;remaining--;
 }
 return allocations.map(p=>Number(p.value));
}

export function validateOperationSplits(report:WorkspaceReport,state:WorkspaceState){
 for(const [rowId,split] of Object.entries(state.operationSplits??{})){
  const row=report.rows.find(r=>r.id===rowId);
  if(!row||!['ledger','zen_statement'].includes(row.source)||row.eur<=0||!row.nativeMinor||!/^-[0-9]+$/u.test(row.nativeMinor))throw new Error('SPLIT_REQUIRES_NATIVE_DEBIT');
  if(row.currency!==split.currency)throw new Error('SPLIT_CURRENCY_MISMATCH');
  if(split.parts.reduce((n,p)=>n+BigInt(p.amountMinor),0n)!==-BigInt(row.nativeMinor))throw new Error('SPLIT_TOTAL_MISMATCH');
  if((state.overrides[rowId]?.excluded??row.excluded)||row.purchaseId||report.rows.some(r=>r.purchaseId===rowId))throw new Error('SPLIT_REQUIRES_UNLINKED_EXPENSE');
  if(state.collections.some(c=>c.rowIds.includes(rowId)||(c.payments??[]).some(p=>p.linkedRowId===rowId)))throw new Error('SPLIT_PARENT_ALREADY_LINKED');
  for(const part of split.parts)if(part.collectionId){
   const collection=state.collections.find(c=>c.id===part.collectionId);
   if(part.kind!=='expense'||!collection||collection.kind!=='purchase'||collection.manualPayment)throw new Error('SPLIT_PURCHASE_INVALID');
  }
 }
}

export function expandOperationSplits(rows:ReportRow[],state:WorkspaceState):ReportRow[]{
 return rows.flatMap(row=>{
  const split=state.operationSplits?.[row.id];if(!split)return [row];
  const eur=allocateValuation(row.eur,split.parts);
  const parent:ReportRow={...row,splitParent:true,excluded:true,operationType:'excluded',unresolved:false};
  const parts=split.parts.map<ReportRow>((part,index)=>({...row,
   id:`split:${row.id}:${part.id}`,splitParentId:row.id,splitPartId:part.id,source:'ledger_split',
   eur:eur[index],nativeMinor:String(-part.amountMinor),currency:split.currency,nativeEur:split.currency==='EUR'?part.amountMinor:null,
   description:part.name,group:part.category,homeGroup:part.category,baseCategory:part.category,
   collectionId:part.collectionId,excluded:part.kind==='unresolved',unresolved:part.kind==='unresolved',
   operationType:part.kind==='expense'?'expense':'excluded',trip:null,
   sourceRefs:[...row.sourceRefs,{parentRowId:row.id,partId:part.id,valuation:'proportional-report'}],
  }));
  return [parent,...parts];
 });
}

import { foreignStatementCategory } from "@/domain/foreign-statement-semantics";
import { parse } from 'csv-parse/sync';
import { parseMinorUnits } from '@/domain/money';
import { hmacIdentifier } from '@/domain/privacy';
import type { NormalizationResult, NormalizedSourceRow, OwnershipContext, ProbeResult, ReconciliationSummary, StatementAdapter } from './types';
import { stableDigest } from './workbook';
const HEADERS=['Type','Product','Started Date','Completed Date','Description','Amount','Fee','Currency','State','Balance'];
interface ParsedRevolut {rows:Array<{line:number;values:string[]}>}
function date(text:string) {
 if(!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(text))throw new Error('REVOLUT_DATE_INVALID');
 const iso=text.replace(' ','T');const parsed=new Date(`${iso}Z`);
 if(!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,19)!==iso)throw new Error('REVOLUT_DATE_INVALID');
 return iso;
}
export class RevolutStatementAdapter implements StatementAdapter<ParsedRevolut> {
 constructor(private readonly options:{identifierKey:Buffer;accountIdentifier:string}) {
  if(!options.accountIdentifier.trim())throw new Error('REVOLUT_ACCOUNT_BINDING_REQUIRED');
 }
 probe(bytes:Buffer):ProbeResult {try{this.parse(bytes);return {matched:true,kind:'revolut_personal'};}catch{return {matched:false,reasonCode:'FORMAT_UNSUPPORTED'};}}
 parse(bytes:Buffer):ParsedRevolut {
  if(!bytes.length||bytes.length>25*1024*1024)throw new Error('REVOLUT_ARTIFACT_SIZE');
  let records:Array<{record:string[];info:{lines:number}}>;
  try{records=parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes),{bom:true,info:true,max_record_size:65536}) as unknown as typeof records;}catch{throw new Error('REVOLUT_CSV_INVALID');}
  if(records.length>100001||JSON.stringify(records[0]?.record)!==JSON.stringify(HEADERS))throw new Error('REVOLUT_HEADERS_UNSUPPORTED');
  return {rows:records.slice(1).map(r=>({line:r.info.lines,values:r.record}))};
 }
 discoverAccounts(parsed:ParsedRevolut) {
  if(!parsed.rows.length||parsed.rows.some(r=>r.values[7]!=='EUR'||r.values[1]!=='Current'))throw new Error('REVOLUT_ACCOUNT_UNSUPPORTED');
  return [{identifierHash:hmacIdentifier(this.options.accountIdentifier,this.options.identifierKey),display:'Revolut EUR · user-bound account',currencies:['EUR']}];
 }
 normalize(parsed:ParsedRevolut,context:OwnershipContext):NormalizationResult {
  const ownIdentifierHash=this.discoverAccounts(parsed)[0]!.identifierHash;
  const rows=parsed.rows.map(({line,values:v}):NormalizedSourceRow=>{
   const fingerprint=stableDigest([ownIdentifierHash,...v]),sourceRecordId=stableDigest([line,fingerprint]);
   const base={sourceRowNumber:line,sourceRecordId,dedupeFingerprint:fingerprint,observations:[],sourceMetadata:{}};
   try {
    if(['DECLINED','REVERTED','PENDING'].includes(v[8]!))return {...base,state:'non_posted',reasonCode:`REVOLUT_${v[8]}`};
    if(v[8]!=='COMPLETED')throw new Error('REVOLUT_STATE_UNSUPPORTED');
    const occurredAt=date(v[3]!);date(v[2]!);
    const amountMinor=parseMinorUnits(v[5]!,'EUR'),fee=parseMinorUnits(v[6]!,'EUR'),balance=parseMinorUnits(v[9]!,'EUR');
    // This accepted zero-fee slice does not guess whether future fees are added
    // to, or already contained in, a provider's settlement amount.
    if(fee!==0n)throw new Error('REVOLUT_NONZERO_FEE_UNSUPPORTED');
    const sourceMetadata={providerType:v[0]!,datePrecision:'second',balanceMinor:balance.toString(),statementCategory:foreignStatementCategory('revolut',{providerType:v[0]},amountMinor>=0n?'credit':'debit',v[4]!)};
    const target=context.ownership.get(ownIdentifierHash);
    if(!target)return {...base,sourceMetadata,state:'unresolved',reasonCode:'OWNERSHIP_MAPPING_REQUIRED'};
    const direction=amountMinor>=0n?'credit':'debit';
    return {...base,sourceMetadata,state:'posted',direction,observations:[{
     id:stableDigest([sourceRecordId,target.accountId]),sourceRecordId,provider:'revolut',accountId:target.accountId,ownerScope:target.ownerScope,
     direction,amountMinor,currency:'EUR',occurredAt,ownIdentifierHash,description:v[4],resultingBalanceMinor:balance,resultingBalanceCurrency:'EUR',
    }]};
   }catch(error){return {...base,state:'rejected',reasonCode:error instanceof Error&&/^[A-Z_]+$/u.test(error.message)?error.message:'REVOLUT_ROW_INVALID'};}
  });
  const latest=new Map<string,NormalizedSourceRow>();
  for(const row of rows){const observation=row.observations[0];if(!observation)continue;const previous=latest.get(observation.occurredAt);if(previous){delete previous.observations[0]!.resultingBalanceMinor;delete previous.observations[0]!.resultingBalanceCurrency;}latest.set(observation.occurredAt,row);}
  return {kind:'revolut_personal',rows};
 }
 reconcile(result:NormalizationResult):ReconciliationSummary {
  const stateCounts={posted:0,non_posted:0,unresolved:0,rejected:0};for(const row of result.rows)stateCounts[row.state]++;
  const rows=result.rows.filter(r=>r.state==='posted'),issues=new Set<string>();
  for(let i=1;i<rows.length;i++){
   const previous=rows[i-1]!,current=rows[i]!;
   if(previous.observations[0]!.occurredAt>current.observations[0]!.occurredAt)issues.add('REVOLUT_DATE_ORDER_INVALID');
   if(BigInt(previous.sourceMetadata.balanceMinor!)+current.observations[0]!.amountMinor!==BigInt(current.sourceMetadata.balanceMinor!))issues.add('BALANCE_DISCONTINUITY');
  }
  return {rowCount:result.rows.length,coveredRowCount:result.rows.length,silentlySkippedRowCount:0,stateCounts,issues:[...issues]};
 }
}

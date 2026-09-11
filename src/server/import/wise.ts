import { foreignStatementCategory } from "@/domain/foreign-statement-semantics";
import { parseMinorUnits } from '@/domain/money';
import { hmacIdentifier } from '@/domain/privacy';
import type { NormalizationResult, NormalizedSourceRow, OwnershipContext, ProbeResult, ReconciliationSummary, StatementAdapter } from './types';
import { readWorkbookTable, indexHeaders, cellValue, textValue, parseBankDate, stableDigest } from './workbook';
const HEADERS=['ID','Date','Date Time','Amount','Currency','Description','Running Balance','Total Fees','Transaction Type','Transaction Details Type'];
type ParsedWise=ReturnType<typeof readWorkbookTable>;
// Wise exports omit the owned account identifier. A caller must supply a stable,
// explicitly user-bound local identity; a filename or counterparty is not identity.
export class WiseStatementAdapter implements StatementAdapter<ParsedWise> {
 constructor(private readonly options:{identifierKey:Buffer;accountIdentifier:string}) {
  if(!options.accountIdentifier.trim()) throw new Error('WISE_ACCOUNT_BINDING_REQUIRED');
 }
 probe(bytes:Buffer):ProbeResult {
  try {this.parse(bytes);return {matched:true,kind:'wise_personal'};}
  catch {return {matched:false,reasonCode:'FORMAT_UNSUPPORTED'};}
 }
 parse(bytes:Buffer):ParsedWise {
  const table=readWorkbookTable(bytes,HEADERS);const headers=indexHeaders(table.headers);
  if(table.rows.some(row=>textValue(cellValue(row.values,headers,'Currency'))!=='EUR')) throw new Error('WISE_CURRENCY_UNSUPPORTED');
  return table;
 }
 discoverAccounts(parsed:ParsedWise) {
  if (!parsed.rows.length) throw new Error("WISE_ROWS_EMPTY");
  return [{identifierHash:hmacIdentifier(this.options.accountIdentifier,this.options.identifierKey),display:'Wise EUR · user-bound account',currencies:['EUR']}];
 }
 normalize(parsed:ParsedWise,context:OwnershipContext):NormalizationResult {
  const headers=indexHeaders(parsed.headers), ownIdentifierHash=this.discoverAccounts(parsed)[0]!.identifierHash;
  const rows=parsed.rows.map((row):NormalizedSourceRow=>{
   const value=(name:string)=>cellValue(row.values,headers,name);
   const fingerprint=stableDigest([ownIdentifierHash,...row.values]);const sourceRecordId=stableDigest([row.sourceRowNumber,fingerprint]);
   const base={sourceRowNumber:row.sourceRowNumber,sourceRecordId,dedupeFingerprint:fingerprint,observations:[],sourceMetadata:{}};
   try {
    if(row.hasFormula)throw new Error('FORMULA_NOT_ALLOWED');
    const occurredAt=parseBankDate(value('Date Time'));
    if(!occurredAt)throw new Error('WISE_DATE_INVALID');
    const amountMinor=parseMinorUnits(value('Amount') as string|number,'EUR');
    const balance=parseMinorUnits(value('Running Balance') as string|number,'EUR');
    const fee=parseMinorUnits(value('Total Fees') as string|number,'EUR');
    const direction=amountMinor>=0n?'credit':'debit';
    if(textValue(value('Transaction Type'))!==direction.toUpperCase() || fee<0n)throw new Error('WISE_DIRECTION_OR_FEE_INVALID');
    const id=textValue(value('ID'));if(!id)throw new Error('WISE_REFERENCE_MISSING');
    const sourceMetadata={datePrecision:'second',detailsType:textValue(value('Transaction Details Type')),explicitFeeMinor:fee.toString(),explicitFeeCurrency:'EUR',statementCategory:foreignStatementCategory('wise',{detailsType:textValue(value('Transaction Details Type'))},direction,textValue(value('Description')))};
    const target=context.ownership.get(ownIdentifierHash);
    if(!target)return {...base,sourceMetadata,state:'unresolved',reasonCode:'OWNERSHIP_MAPPING_REQUIRED'};
    return {...base,sourceMetadata,state:'posted',direction,observations:[{
     id:stableDigest([sourceRecordId,target.accountId]),sourceRecordId,provider:'wise',accountId:target.accountId,ownerScope:target.ownerScope,
     amountMinor,currency:'EUR',direction,occurredAt,ownIdentifierHash,
     providerReference:`${id}:${direction}`,description:textValue(value('Description')),
     resultingBalanceMinor:balance,resultingBalanceCurrency:'EUR',
     ...(fee>0n?{explicitFeeMinor:fee,explicitFeeCurrency:'EUR'}:{}),
    }]};
   } catch(error) {return {...base,state:'rejected',reasonCode:error instanceof Error && /^[A-Z_]+$/u.test(error.message)?error.message:'WISE_ROW_INVALID'};}
  });
  return {kind:'wise_personal',rows};
 }
 reconcile(result:NormalizationResult):ReconciliationSummary {
  const stateCounts={posted:0,non_posted:0,unresolved:0,rejected:0};for(const row of result.rows)stateCounts[row.state]++;
  // Preserve reversed source order for equal timestamps in Wise's newest-first export.
  const observations=result.rows.slice().reverse().flatMap(row=>row.observations).sort((a,b)=>a.occurredAt.localeCompare(b.occurredAt));
  const failed=observations.slice(1).some((row,i)=>observations[i]!.resultingBalanceMinor!+row.amountMinor!==row.resultingBalanceMinor);
  return {rowCount:result.rows.length,coveredRowCount:result.rows.length,silentlySkippedRowCount:0,stateCounts,issues:failed?['BALANCE_DISCONTINUITY']:[]};
 }
}

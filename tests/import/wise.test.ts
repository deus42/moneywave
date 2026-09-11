import { expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { WiseStatementAdapter } from '../../src/server/import/wise';
function fixture() {
 const sheet=XLSX.utils.aoa_to_sheet([
 ['ID','Date','Date Time','Amount','Currency','Description','Running Balance','Total Fees','Transaction Type','Transaction Details Type'],
 ['SYNTH-CARD',45659,45659.5,4,'EUR','Synthetic refund',94,0,'CREDIT','CARD'],
 ['SYNTH-CARD',45658,45658.5,-10,'EUR','Synthetic card',90,0,'DEBIT','CARD'],
 ['SYNTH-IN',45657,45657.5,100,'EUR','Synthetic deposit',100,0,'CREDIT','DEPOSIT'],
 ]); const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,sheet,'Synthetic');return XLSX.write(book,{type:'buffer',bookType:'xlsx'}) as Buffer;
}
it('handles newest-first balances and preserves a refund sharing the original ID',()=>{
 const adapter=new WiseStatementAdapter({identifierKey:Buffer.alloc(32,4),accountIdentifier:'synthetic-user-bound-wise'});
 const parsed=adapter.parse(fixture());const identifier=adapter.discoverAccounts(parsed)[0]!;
 const result=adapter.normalize(parsed,{mappingComplete:true,ownership:new Map([[identifier.identifierHash,{accountId:'synthetic-wise',ownerScope:'PERSONAL'}]])});
 expect(result.rows.map(r=>r.state)).toEqual(['posted','posted','posted']);
 expect(new Set(result.rows.map(r=>r.observations[0]!.providerReference)).size).toBe(3);
 expect(adapter.reconcile(result).issues).toEqual([]);
 expect(result.rows.map(r=>r.observations[0]!.amountMinor)).toEqual([400n,-1000n,10000n]);
});

import { expect, it } from 'vitest';
import { RevolutStatementAdapter } from '../../src/server/import/revolut';
const header='Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance';
const adapter=new RevolutStatementAdapter({identifierKey:Buffer.alloc(32,5),accountIdentifier:'synthetic-bound-revolut'});
function normalize(text:string){const p=adapter.parse(Buffer.from(text));const id=adapter.discoverAccounts(p)[0]!;return adapter.normalize(p,{mappingComplete:true,ownership:new Map([[id.identifierHash,{accountId:'synthetic-revolut',ownerScope:'PERSONAL'}]])});}
it('imports completed rows and preserves declined rows as non-posted evidence',()=>{
 const result=normalize([header,
 'Deposit,Current,2025-01-01 10:00:00,2025-01-01 10:00:00,Synthetic deposit,100,0,EUR,COMPLETED,100',
 'Card Payment,Current,2025-01-02 10:00:00,2025-01-02 10:00:00,Synthetic shop,-20,0,EUR,COMPLETED,80',
 'Card Payment,Current,2025-01-03 10:00:00,,Synthetic declined,-5,0,EUR,DECLINED,',
 ].join('\n'));
 expect(result.rows.map(r=>r.state)).toEqual(['posted','posted','non_posted']);
 expect(adapter.reconcile(result).issues).toEqual([]);
 expect(result.rows[1]!.observations[0]!.amountMinor).toBe(-2000n);
});
it('rejects unsupported nonzero fee semantics and invalid dates',()=>{
 expect(normalize(`${header}\nCard Payment,Current,2025-01-01 00:00:00,2025-01-01 00:00:00,Synthetic,-10,1,EUR,COMPLETED,89`).rows[0]!.state).toBe('rejected');
 expect(normalize(`${header}\nDeposit,Current,2025-01-01 00:00:00,2025-02-30 00:00:00,Synthetic,100,0,EUR,COMPLETED,100`).rows[0]!.state).toBe('rejected');
});

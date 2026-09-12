import type {EncryptedDatabase} from '@/server/db/database';
import {monthEnd} from '@/server/manual/position-workbook';

export interface CashMonthObservation {
 accountId:string|null;
 seriesId:string;
 name:string;
 currency:string;
 period:string;
 amountMinor:string|null;
 conflicting:boolean;
 sources:Array<{sheet:string;address:string}>;
}

/** Observations only: no carry-forward, formula values, valuation or inferred movements. */
export async function cashHistory(db:EncryptedDatabase,asOf:string):Promise<CashMonthObservation[]> {
 const rows=await db.all<{id:string;seriesId:string;accountId:string|null;name:string;currency:string;period:string;amountMinor:string;sheet:string|null;address:string|null}>(`
  SELECT f.id,s.id AS seriesId,s.account_id AS accountId,s.display_name AS name,s.currency,f.period,
   CAST(f.amount_minor AS TEXT) AS amountMinor,c.sheet_name AS sheet,c.cell_address AS address
  FROM manual_position_facts f JOIN manual_position_series s ON s.id=f.series_id
  LEFT JOIN manual_source_cells c ON c.fact_id=f.id
  WHERE s.position_kind='cash' AND f.period<=?
  ORDER BY f.period DESC,s.id,f.id,c.sheet_name,c.cell_address`,[asOf.slice(0,7)]);
 const groups=new Map<string,CashMonthObservation>();
 for(const row of rows){
  if(monthEnd(row.period)>asOf)continue;
  const key=JSON.stringify([row.accountId?`account:${row.accountId}`:`series:${row.seriesId}`,row.period]);
  let group=groups.get(key);
  if(!group){group={accountId:row.accountId,seriesId:row.seriesId,name:row.name,currency:row.currency,period:row.period,amountMinor:row.amountMinor,conflicting:false,sources:[]};groups.set(key,group);}
  if(group.amountMinor!==row.amountMinor||group.currency!==row.currency){group.amountMinor=null;group.conflicting=true;}
  if(row.sheet&&row.address&&!group.sources.some(s=>s.sheet===row.sheet&&s.address===row.address))group.sources.push({sheet:row.sheet,address:row.address});
 }
 return [...groups.values()];
}

import Decimal from 'decimal.js';
import {z} from 'zod';
import type {EncryptedDatabase} from '@/server/db/database';

const Exact=Decimal.clone({precision:50,rounding:Decimal.ROUND_HALF_UP});
export const cashExpenseInputSchema=z.object({
  id:z.string().min(1).max(120),accountId:z.string().min(1).max(180),date:z.iso.date(),amountMinor:z.number().int().positive().max(1e12),
  category:z.string().trim().min(1).max(240),description:z.string().trim().max(240).default(''),
});
export const cashExpenseSchema=cashExpenseInputSchema.extend({
  currency:z.enum(['EUR','USD','UAH']),eur:z.number().int().nonnegative().max(1e12),
  rate:z.string().min(1).max(100),rateSource:z.enum(['identity','ECB','NBU']),publicationDate:z.iso.date(),
});
export type CashExpense=z.infer<typeof cashExpenseSchema>;
export type CashExpenseInput=z.infer<typeof cashExpenseInputSchema>;
export interface CashAccount {id:string;name:string;currency:CashExpense['currency'];openingDate:string|null}

export async function cashAccounts(db:EncryptedDatabase):Promise<CashAccount[]> {
  return db.all<CashAccount>(`SELECT a.id,a.display_name AS name,a.currency,o.opening_date AS openingDate
    FROM accounts a LEFT JOIN cash_opening_balances o ON o.account_id=a.id
    WHERE a.account_type='cash' AND a.owner_scope='PERSONAL' AND a.currency IN ('EUR','USD','UAH')
    ORDER BY CASE a.currency WHEN 'EUR' THEN 0 WHEN 'USD' THEN 1 ELSE 2 END,a.id`);
}

/** Explicit personal cash only. Native money and dated cached valuation are retained together. */
export async function prepareCashExpense(db:EncryptedDatabase,input:CashExpenseInput,today:string,previous?:CashExpense):Promise<CashExpense> {
  if(input.date>today)throw new Error('FUTURE_CASH_EXPENSE');
  const account=(await cashAccounts(db)).find(a=>a.id===input.accountId);
  if(!account)throw new Error('CASH_ACCOUNT_INVALID');
  if(account.openingDate && input.date<account.openingDate)throw new Error('CASH_BEFORE_OPENING');
  if(['__proto__','constructor','prototype'].includes(input.category))throw new Error('CATEGORY_INVALID');
  if(previous && previous.accountId===input.accountId && previous.currency===account.currency && previous.date===input.date && previous.amountMinor===input.amountMinor)
    return cashExpenseSchema.parse({...previous,...input});
  const rate=account.currency==='EUR'?{rate:'1',rateSource:'identity',publicationDate:input.date}:await db.get<{rate:string;rateSource:string;publicationDate:string}>(`
    SELECT rate,source AS rateSource,publicationDate FROM (
      SELECT base_currency AS base,quote_currency AS target,rate_text AS rate,source,publication_date AS publicationDate,requested_date AS requestedDate FROM fx_rate_cache
      UNION SELECT source_currency,target_currency,rate_text,source,publication_date,requested_date FROM ledger_entry_valuations
      UNION SELECT source_currency,target_currency,rate_text,source,publication_date,requested_date FROM balance_snapshot_valuations
    ) WHERE base=? AND target='EUR' AND source IN ('ECB','NBU') AND publicationDate<=? AND requestedDate<=?
    ORDER BY publicationDate DESC,CASE source WHEN 'ECB' THEN 0 ELSE 1 END,requestedDate DESC LIMIT 1`,[account.currency,input.date,input.date]);
  if(!rate || Date.parse(input.date)-Date.parse(rate.publicationDate)>7*86_400_000 || !new Exact(rate.rate).isFinite() || !new Exact(rate.rate).gt(0))throw new Error('CASH_RATE_UNAVAILABLE');
  return cashExpenseSchema.parse({...input,currency:account.currency,eur:Number(new Exact(input.amountMinor).mul(rate.rate).toFixed(0)),...rate});
}

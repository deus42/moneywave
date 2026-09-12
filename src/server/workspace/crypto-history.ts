import Decimal from 'decimal.js';
import {z} from 'zod';
import {monthEnd} from '@/server/manual/position-workbook';
import {cryptoObservationSchema,type CryptoPosition} from './crypto';

const Exact=Decimal.clone({precision:50,rounding:Decimal.ROUND_HALF_UP});
export function parseCryptoQuantity(value:string|null,asset:'NEAR'|'ETH'|'USDT'):string|null {
 if(value===null||value.length>80)return null;
 const text=value.trim().replace(new RegExp(` ${asset}$`,'u'),'');
 const terms=text.split('+').map(v=>v.trim());
 if(terms.length>2||terms.some(v=>!/^(?:\d{1,20}|\d{1,3}(?: \d{3}){1,6})(?:\.\d{1,24})?$/u.test(v)))return null;
 return terms.reduce((sum,v)=>sum.add(v.replaceAll(' ','')),new Exact(0)).toFixed();
}
const month=z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u);
const positive=z.string().regex(/^\d{1,20}(?:\.\d{1,24})?$/u).refine(v=>new Exact(v).gt(0));
const pair=z.enum(['NEARUSDT','ETHUSDT','EURUSDT']);
const priceSchema=z.object({month,pair,open:positive,sourceUrl:z.url(),evidenceSha256:z.string().regex(/^[a-f0-9]{64}$/u),capturedAt:z.iso.datetime()}).superRefine((p,ctx)=>{
 const url=new URL(p.sourceUrl);
 if(url.protocol!=='https:'||url.hostname!=='data-api.binance.vision'||url.pathname!=='/api/v3/klines'||url.username||url.password||url.port||url.searchParams.get('symbol')!==p.pair||url.searchParams.get('interval')!=='1M'||!['0',null].includes(url.searchParams.get('timeZone'))||p.capturedAt.slice(0,10)<p.month+'-01')ctx.addIssue({code:'custom',message:'PRICE_SOURCE_INVALID'});
});
/** Explicit operator evidence in an immutable encrypted report; no network on reads. */
export const cryptoHistorySchema=z.object({
 holdings:z.array(z.object({observation:cryptoObservationSchema,fromMonth:month,confirmedAt:z.iso.datetime(),quantityBasis:z.enum(['user_confirmed_constant','unknown']),assets:z.array(z.enum(['NEAR','ETH','USDT']).nullable()).min(1).max(100)})).max(10),
 prices:z.array(priceSchema).max(3600),
}).superRefine((h,ctx)=>{
 const wallets=new Set<string>(),prices=new Set<string>();
 for(const holding of h.holdings){
  const o=holding.observation,key=`${o.chain}:${o.account.toLowerCase()}`;
  if(wallets.has(key)||holding.assets.length!==o.parts.length||holding.fromMonth>o.observedAt.slice(0,7)||holding.confirmedAt<o.observedAt)ctx.addIssue({code:'custom',message:'HOLDING_HISTORY_INVALID'});
  wallets.add(key);
  holding.assets.forEach((asset,i)=>{
   if(asset===null)return;
   const quantity=o.parts[i]?.quantity;
   if(parseCryptoQuantity(quantity??null,asset)===null||(o.chain==='near'?asset!=='NEAR':asset==='NEAR'))ctx.addIssue({code:'custom',message:'HOLDING_QUANTITY_INVALID'});
  });
 }
 for(const p of h.prices){const key=`${p.month}:${p.pair}`;if(prices.has(key))ctx.addIssue({code:'custom',message:'PRICE_CONFLICT'});prices.add(key);}
});
export type CryptoHistory=z.infer<typeof cryptoHistorySchema>;
export interface HistoricalCryptoPosition extends Omit<CryptoPosition,'usdMinor'|'parts'> {
 usdMinor:null;
 parts:Array<CryptoPosition['parts'][number]&{asset:string|null;priceUsdt:string|null;usdt:string|null;eurMinor:string|null}>;
 unpricedCount:number;
 historical:{month:string;priceDate:string;eurUsdt:string|null;quantityBasis:'user_confirmed_constant'|'unknown';holdingSince:string;sources:CryptoHistory['prices']};
}
export type CapitalCryptoPosition=CryptoPosition|HistoricalCryptoPosition;

/** An observed wallet replaces its estimate once; missing monthly quotes never carry forward. */
export function withCryptoHistory(observed:CryptoPosition[],history:CryptoHistory|undefined,asOf:string):CapitalCryptoPosition[]{
 const result:CapitalCryptoPosition[]=observed.filter(p=>p.observedAt.slice(0,10)<=asOf),period=asOf.slice(0,7);
 for(const holding of history?.holdings??[]){
  const o=holding.observation;
  if(result.some(p=>p.chain===o.chain&&p.account.toLowerCase()===o.account.toLowerCase())||monthEnd(holding.fromMonth)>asOf)continue;
  const prices=history!.prices.filter(p=>p.month===period&&p.month+'-01'<=asOf),eur=prices.find(p=>p.pair==='EURUSDT');
  let total=new Exact(0),valued=0;
  const parts=o.parts.map((part,i)=>{
   const asset=holding.assets[i],price=asset==='USDT'?'1':asset?prices.find(p=>p.pair===`${asset}USDT`)?.open??null:null;
   const quantity=asset&&holding.quantityBasis==='user_confirmed_constant'?parseCryptoQuantity(part.quantity,asset):null;
   const usdt=price&&quantity!==null?new Exact(quantity).mul(price):null;
   if(usdt!==null&&eur){total=total.add(usdt.div(eur.open));valued++;}
   return {...part,quantity:holding.quantityBasis==='unknown'?null:quantity??part.quantity,usdMinor:null,asset,priceUsdt:price,usdt:usdt?.toFixed()??null,eurMinor:usdt!==null&&eur?usdt.div(eur.open).mul(100).toFixed(0):null};
  });
  result.push({...o,observedAt:period+'-01T00:00:00.000Z',usdMinor:null,eurMinor:valued?total.mul(100).toFixed(0):null,fx:null,parts,unpricedCount:parts.length-valued,
   note:holding.quantityBasis==='unknown'?'Період володіння відомий; кількість за минулі місяці потребує підтвердження.':'Історична оцінка за підтвердженою незмінною кількістю. LP та активи без історичної ціни не включені.',
   historical:{month:period,priceDate:period+'-01',eurUsdt:eur?.open??null,quantityBasis:holding.quantityBasis,holdingSince:holding.fromMonth,sources:prices}});
 }
 return result;
}

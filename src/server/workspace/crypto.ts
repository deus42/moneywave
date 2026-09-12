import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import { z } from 'zod';
import type { EncryptedDatabase } from '@/server/db/database';
import type { CapitalCryptoPosition } from './crypto-history';
import type { CapitalView } from '@/server/read-model/finance-centers';

const Exact = Decimal.clone({precision:50,rounding:Decimal.ROUND_HALF_UP});
const minor = z.number().int().nonnegative().max(1e12);
export const cryptoObservationSchema = z.object({
  chain:z.enum(['near','ethereum']), account:z.string().min(2).max(80),
  observedAt:z.iso.datetime(), source:z.enum(['Pikespeak','Etherscan']), sourceUrl:z.url(),
  usdMinor:minor, evidenceSha256:z.string().regex(/^[a-f0-9]{64}$/u),
  parts:z.array(z.object({label:z.string().min(1).max(100),quantity:z.string().max(80).nullable(),usdMinor:minor.nullable()})).min(1).max(100),
  note:z.string().max(1000).default(''),
}).superRefine((v,ctx)=>{
  const near=v.chain==='near', account=near?v.account:v.account.toLowerCase();
  const validAccount=near?/^[a-z0-9_.-]{2,64}$/u.test(account):/^0x[a-f0-9]{40}$/u.test(account);
  const url=new URL(v.sourceUrl);
  const validSource=near?v.source==='Pikespeak'&&url.hostname==='pikespeak.ai'&&url.pathname===`/account/${account}`
    :v.source==='Etherscan'&&url.hostname==='etherscan.io'&&url.pathname.toLowerCase()===`/address/${account}`;
  if(!validAccount||!validSource||url.protocol!=='https:'||url.username||url.password||url.port)ctx.addIssue({code:'custom',message:'SOURCE_IDENTITY_MISMATCH'});
  if(v.parts.reduce((sum,p)=>sum+BigInt(p.usdMinor??0),0n)!==BigInt(v.usdMinor))ctx.addIssue({code:'custom',message:'NAV_BREAKDOWN_MISMATCH'});
});
export type CryptoObservation=z.infer<typeof cryptoObservationSchema>;
export interface CryptoPosition extends CryptoObservation {
  eurMinor:string|null;
  fx:{rate:string;source:string;publicationDate:string;stale:boolean}|null;
}

/** Explicit captured explorer evidence only; page reads never contact a wallet or provider. */
export class CryptoStore {
  constructor(private readonly db:EncryptedDatabase,private readonly now=()=>new Date()){}
  async save(input:unknown){
    const observation=cryptoObservationSchema.parse(input);
    if(observation.observedAt>this.now().toISOString())throw new Error('FUTURE_CRYPTO_OBSERVATION');
    if(observation.chain==='ethereum')observation.account=observation.account.toLowerCase();
    const payload=JSON.stringify(observation),digest=createHash('sha256').update(payload).digest('hex');
    const key=`${observation.chain}:${observation.account}`;
    const prior=await this.db.get<{digest:string}>('SELECT digest FROM crypto_observations WHERE wallet_key=? AND observed_at=?',[key,observation.observedAt]);
    if(prior&&prior.digest!==digest)throw new Error('CRYPTO_OBSERVATION_CONFLICT');
    await this.db.run('INSERT OR IGNORE INTO crypto_observations(digest,wallet_key,observed_at,payload_json) VALUES(?,?,?,?)',[digest,key,observation.observedAt,payload]);
    return digest;
  }
  async positions(asOf:string):Promise<CryptoPosition[]>{
    const day=[asOf,this.now().toISOString().slice(0,10)].sort()[0];
    const rows=await this.db.all<{payload_json:string}>(`SELECT payload_json FROM (
      SELECT payload_json,row_number() OVER (PARTITION BY wallet_key ORDER BY observed_at DESC) AS rank
      FROM crypto_observations WHERE substr(observed_at,1,10)<=?
    ) WHERE rank=1 ORDER BY payload_json`,[day]);
    const fx=await this.db.get<{rate:string;source:string;publicationDate:string}>(`SELECT rate,source,publicationDate FROM (
      SELECT base_currency AS base,quote_currency AS target,rate_text AS rate,source,publication_date AS publicationDate,requested_date AS requestedDate FROM fx_rate_cache
      UNION SELECT source_currency,target_currency,rate_text,source,publication_date,requested_date FROM ledger_entry_valuations WHERE source!='identity'
      UNION SELECT source_currency,target_currency,rate_text,source,publication_date,requested_date FROM balance_snapshot_valuations WHERE source!='identity'
    ) WHERE base='USD' AND target='EUR' AND publicationDate<=? AND requestedDate<=?
      ORDER BY publicationDate DESC,CASE source WHEN 'ECB' THEN 0 ELSE 1 END,requestedDate DESC LIMIT 1`,[day,day]);
    const valid=fx&&new Exact(fx.rate).isFinite()&&new Exact(fx.rate).gt(0)?fx:null;
    return rows.map(row=>({...cryptoObservationSchema.parse(JSON.parse(row.payload_json)),
      eurMinor:valid?new Exact(JSON.parse(row.payload_json).usdMinor).mul(valid.rate).toFixed(0):null,
      fx:valid?{...valid,stale:Date.parse(day)-Date.parse(valid.publicationDate)>7*86400000}:null}));
  }
}

export function addCryptoToCapital(base:CapitalView,crypto:CapitalCryptoPosition[]){
  const valued=crypto.filter(p=>p.eurMinor!==null);
  const total=valued.reduce((sum,p)=>sum+BigInt(p.eurMinor!),0n);
  return {...base,bankNetMinor:base.knownNetMinor,crypto,cryptoMinor:total.toString(),
    cryptoUnpricedCount:crypto.reduce((n,p)=>n+('unpricedCount' in p?p.unpricedCount:p.parts.filter(part=>part.usdMinor===null).length),0),
    knownAssetsMinor:(BigInt(base.knownAssetsMinor)+total).toString(),
    knownNetMinor:(BigInt(base.knownNetMinor)+total).toString(),
    unvaluedCount:base.unvaluedCount+crypto.length-valued.length};
}

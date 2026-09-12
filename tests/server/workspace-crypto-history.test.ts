import {describe,it,expect} from 'vitest';
import {cryptoHistorySchema,withCryptoHistory,parseCryptoQuantity} from '@/server/workspace/crypto-history';

const observation={chain:'near',account:'synthetic.near',source:'Pikespeak',sourceUrl:'https://pikespeak.ai/account/synthetic.near',observedAt:'2090-03-10T00:00:00.000Z',usdMinor:10000,evidenceSha256:'a'.repeat(64),parts:[{label:'SYNTHETIC NEAR',quantity:'12.345',usdMinor:10000},{label:'SYNTHETIC unknown LP',quantity:null,usdMinor:null}],note:''};
const price=(pair:string,open:string,month='2090-02')=>({pair,open,month,sourceUrl:`https://data-api.binance.vision/api/v3/klines?symbol=${pair}&interval=1M&startTime=0&limit=1000`,evidenceSha256:'b'.repeat(64),capturedAt:'2090-03-12T00:00:00.000Z'});
const history=()=>cryptoHistorySchema.parse({holdings:[{observation,fromMonth:'2090-02',confirmedAt:'2090-03-12T00:00:00.000Z',quantityBasis:'user_confirmed_constant',assets:['NEAR',null]}],prices:[price('NEARUSDT','2.5'),price('EURUSDT','1.25')]});

describe('explicit monthly crypto reconstruction (synthetic)',()=>{
 it('reads bounded displayed quantities without evaluating expressions or guessing units',()=>{
  expect(parseCryptoQuantity('12.34 + 0.0005 NEAR','NEAR')).toBe('12.3405');
  expect(parseCryptoQuantity('12 345.67 NEAR','NEAR')).toBe('12345.67');
  expect(parseCryptoQuantity('1 234.567890','USDT')).toBe('1234.56789');
  for(const text of ['12 ETH','1 2 NEAR','2*3 NEAR','approx 2 NEAR','-1 NEAR'])expect(parseCryptoQuantity(text,'NEAR')).toBeNull();
 });
 it('uses first-of-month USDT quotes and the matching EUR quote with a single final rounding',()=>{
  const p=withCryptoHistory([],history(),'2090-02-28')[0];
  expect(p).toMatchObject({eurMinor:'2469',usdMinor:null,observedAt:'2090-02-01T00:00:00.000Z',unpricedCount:1});
  if(!('historical' in p))throw new Error('HISTORY_EXPECTED');
  expect(p.historical).toMatchObject({month:'2090-02',priceDate:'2090-02-01',eurUsdt:'1.25',quantityBasis:'user_confirmed_constant'});
  expect(p.parts[0]).toMatchObject({quantity:'12.345',priceUsdt:'2.5',eurMinor:'2469'});
  expect(p.parts[1].eurMinor).toBeNull();
 });
 it('preserves acquisition month precision and never prices a missing month from another month',()=>{
  expect(withCryptoHistory([],history(),'2090-01-31')).toEqual([]);
  expect(withCryptoHistory([],history(),'2090-02-12')).toEqual([]);
  expect(withCryptoHistory([],history(),'2090-03-09')[0].eurMinor).toBeNull();
 });
 it('lets a dated observed wallet replace its reconstruction once without duplicating NAV',()=>{
  const actual={...observation,chain:'near' as const,source:'Pikespeak' as const,eurMinor:'8000',fx:null};
  expect(withCryptoHistory([actual],history(),'2090-03-12')).toEqual([actual]);
 });
 it('prices USDT using EURUSDT directly and makes missing conversion evidence explicit',()=>{
  const h=history();h.holdings[0].assets=['USDT',null];
  expect(withCryptoHistory([],h,'2090-02-28')[0].eurMinor).toBe('988');
  h.prices=h.prices.filter(p=>p.pair!=='EURUSDT');
  expect(withCryptoHistory([],h,'2090-02-28')[0].eurMinor).toBeNull();
 });

 it('starts the Ethereum wallet in the confirmed month and preserves unknown token values',()=>{
  const h=history(),account='0x'+'cd'.repeat(20);
  h.holdings.push({...h.holdings[0],observation:{...h.holdings[0].observation,chain:'ethereum',account,source:'Etherscan',sourceUrl:`https://etherscan.io/address/${account}`},assets:['ETH',null]});
  h.prices.push({...h.prices[0],pair:'ETHUSDT',open:'1000',sourceUrl:'https://data-api.binance.vision/api/v3/klines?symbol=ETHUSDT&interval=1M'});
  expect(withCryptoHistory([],h,'2090-01-31')).toEqual([]);
  expect(withCryptoHistory([],h,'2090-02-28').find(p=>p.chain==='ethereum')).toMatchObject({eurMinor:'987600',unpricedCount:1});
 });
 it('records known holding periods without inventing historical quantities',()=>{
  const h=history();h.holdings[0].quantityBasis='unknown';
  const p=withCryptoHistory([],h,'2090-02-28')[0];
  expect(p.eurMinor).toBeNull();expect(p.parts[0].quantity).toBeNull();
  expect(p).toMatchObject({historical:{holdingSince:'2090-02',quantityBasis:'unknown'}});
 });
 it('rejects duplicate prices, missing quantity mappings and untrusted price sources',()=>{
  const h=history();
  expect(()=>cryptoHistorySchema.parse({...h,prices:[...h.prices,h.prices[0]]})).toThrow();
  expect(()=>cryptoHistorySchema.parse({...h,holdings:[{...h.holdings[0],assets:['NEAR','NEAR']}]})).toThrow();
  expect(()=>cryptoHistorySchema.parse({...h,prices:[{...h.prices[0],sourceUrl:'https://evil.invalid/price'}]})).toThrow();
 });
});

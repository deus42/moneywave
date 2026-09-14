import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isIPv4 } from 'node:net';
import type { WorkspaceStore } from './store';
import {purchaseLinkAudit} from './purchase-links';
import { annualComparison, annualComparisonSchema, collectionTotals, comparisonFor, effectiveRows, purchaseValue, reportingCoverage, summary, workspaceCalendar } from './model';
import {withCryptoHistory} from './crypto-history';
import { includeWorkspacePosition } from './capital';
import { savingsView } from './savings';
import { budgetYears } from './budget-years';
import { addCryptoToCapital, type CryptoStore } from './crypto';
import type { FinanceCenters } from '@/server/read-model/finance-centers';

function same(a: string | undefined, b: string): boolean {
  return typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a),Buffer.from(b));
}
function reply(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8'});
  res.end(JSON.stringify(value));
}
async function body(req: IncomingMessage): Promise<unknown> {
  let count = 0; const chunks: Buffer[] = [];
  for await (const part of req) { const chunk = Buffer.from(part); count += chunk.length; if(count <= 128_000) chunks.push(chunk); }
  if(count > 128_000) throw new Error('BODY_TOO_LARGE');
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export function createWorkspaceServer(options: {store:WorkspaceStore; centers:Pick<FinanceCenters,'capital'|'capitalHistory'>; crypto?:Pick<CryptoStore,'positions'>; now?:()=>Date; staticDirectory:string; sourceCurrent:boolean; release?:string; tailscale?:{origin:string;login:string;proxyAddress?:string}}) {
  const remote = options.tailscale ? new URL(options.tailscale.origin) : undefined;
  if (remote && (remote.protocol !== 'https:' || !remote.hostname.endsWith('.ts.net')
    || remote.origin !== options.tailscale!.origin || !options.tailscale!.login.trim()
    || (options.tailscale!.proxyAddress!==undefined&&!isIPv4(options.tailscale!.proxyAddress)))) throw new Error('TAILSCALE_CONFIG_INVALID');
  const session = randomBytes(32).toString('hex'), csrf = randomBytes(32).toString('hex');
  const assets: Record<string,{file:string;type:string}> = {
    '/':{file:'index.html',type:'text/html'},'/app.js':{file:'app.js',type:'text/javascript'},'/navigation.js':{file:'navigation.js',type:'text/javascript'},'/privacy.js':{file:'privacy.js',type:'text/javascript'},'/style.css':{file:'style.css',type:'text/css'},
    '/moneywave-mark.png':{file:'moneywave-mark.png',type:'image/png'},
  };
  const server = createServer(async (req,res) => {
    res.setHeader('Cache-Control','no-store');
    res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('X-Frame-Options','DENY'); res.setHeader('Referrer-Policy','no-referrer');
    const address = server.address();
    if (!address || typeof address === 'string') return reply(res,503,{error:'UNAVAILABLE'});
    const localHost = `127.0.0.1:${address.port}`;
    const viaTailscale = Boolean(remote);
    // Serve strips client-supplied identity headers. Only its loopback connection
    // and the explicitly configured HTTPS host may use the owner identity.
    if (viaTailscale && ((req.socket.remoteAddress !== '127.0.0.1' && req.socket.remoteAddress !== options.tailscale!.proxyAddress)
      || !same(req.headers['tailscale-user-login'] as string | undefined,options.tailscale!.login))) return reply(res,403,{error:'REQUEST_DENIED'});
    const host = remote?.host ?? localHost, origin = remote?.origin ?? `http://${localHost}`;
    if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== origin)
      || (req.headers['sec-fetch-site'] && !['none','same-origin'].includes(String(req.headers['sec-fetch-site'])))) return reply(res,403,{error:'REQUEST_DENIED'});
    const url = new URL(req.url ?? '/',origin);
    const cookies = (req.headers.cookie ?? '').split(';').map(v => v.trim());
    const cookieName = `${viaTailscale ? '__Host-' : ''}moneywave_session_${address.port}`;
    const authenticated = cookies.some(cookie => same(cookie,`${cookieName}=${session}`));
    try {
      if(req.method==='GET'&&url.pathname==='/healthz')return reply(res,200,{status:'ok',release:options.release??null});
      if (req.method === 'GET' && Object.hasOwn(assets,url.pathname)) {
        if (url.pathname === '/') res.setHeader('Set-Cookie',`${cookieName}=${session}; HttpOnly; SameSite=Strict; Path=/${viaTailscale ? '; Secure' : ''}`);
        const asset = assets[url.pathname];
        const content = await readFile(join(options.staticDirectory,asset.file));
        res.writeHead(200,{'Content-Type':asset.type.startsWith('text/')?`${asset.type}; charset=utf-8`:asset.type}); res.end(content); return;
      }
      if (!authenticated) return reply(res,401,{error:'SESSION_REQUIRED'});
      if (req.method === 'GET' && url.pathname === '/api/workspace') {
        const {revision,report,state} = await options.store.read();
        const rows=effectiveRows(report,state);
        return reply(res,200,{revision,purchaseLinkAudit:purchaseLinkAudit(state.collections,rows,report.rows),report:reportingCoverage(report,state),calendar:workspaceCalendar(report,state),statementCoverage:report.coverage,state,rows:rows.map(r=>({...r,purchaseValue:purchaseValue(r)})),
          collectionTotals:Object.fromEntries(state.collections.map(c=>[c.id,collectionTotals(c,rows)])),cashAccounts:await options.store.cashAccounts(),cashHistory:await options.store.cashHistory(),csrf,sourceCurrent:options.sourceCurrent});
      }
      if (req.method === 'GET' && url.pathname === '/api/period') {
        const {report,state,revision} = await options.store.read();
        const currentDate=(options.now?.()??new Date()).toISOString().slice(0,10);
        const data = summary(report,state,url.searchParams.get('period') ?? '',currentDate);
        const asOf = data.period === 'all' ? currentDate : [data.range.to,currentDate].sort()[0];
        const capital=addCryptoToCapital(await options.centers.capital(asOf,'EUR',includeWorkspacePosition,state.cashExpenses),withCryptoHistory(await options.crypto?.positions(asOf)??[],report.cryptoHistory,asOf));
        const currentCapital=asOf===currentDate?capital:addCryptoToCapital(await options.centers.capital(currentDate,'EUR',includeWorkspacePosition,state.cashExpenses),withCryptoHistory(await options.crypto?.positions(currentDate)??[],report.cryptoHistory,currentDate));
        return reply(res,200,{...data,revision,comparison:comparisonFor(report,state,data.period,data.availableRange?.to??asOf,currentDate),capital,currentCapital});
      }
      if (req.method === 'GET' && url.pathname === '/api/savings') {
        const {report,state,revision} = await options.store.read();
        const currentDate=(options.now?.()??new Date()).toISOString().slice(0,10);
        return reply(res,200,{...await savingsView(options.centers,report,state,url.searchParams.get('period') ?? '',currentDate),revision});
      }
      if (req.method === 'GET' && url.pathname === '/api/history') return reply(res,200,await options.store.history());
      if (req.method === 'GET' && url.pathname === '/api/budget-years') {
        const {report,state,revision}=await options.store.read();
        return reply(res,200,{revision,years:budgetYears(report,state,(options.now?.()??new Date()).toISOString().slice(0,10))});
      }
      if (req.method === 'GET' && url.pathname === '/api/annual-comparison') {
        const request = annualComparisonSchema.parse({mode:url.searchParams.get('mode'),year:Number(url.searchParams.get('year')),asOf:url.searchParams.get('asOf')});
        const {report,state,revision} = await options.store.read();
        return reply(res,200,{...annualComparison(report,state,request),revision});
      }
      if (req.method === 'GET' && url.pathname === '/api/capital-history') {
        const {report,state} = await options.store.read();
        const currentDate=(options.now?.()??new Date()).toISOString().slice(0,10);
        const points=await options.centers.capitalHistory(currentDate,'EUR',includeWorkspacePosition,state.cashExpenses);
        const history=[];
        for(const point of points){
          const crypto=withCryptoHistory(await options.crypto?.positions(point.asOf)??[],report.cryptoHistory,point.asOf);
          const valued=crypto.filter(p=>p.eurMinor!==null),total=valued.reduce((n,p)=>n+BigInt(p.eurMinor!),0n);
          history.push({...point,cryptoUnpricedCount:crypto.reduce((n,p)=>n+('unpricedCount' in p?p.unpricedCount:p.parts.filter(part=>part.usdMinor===null).length),0),bankMinor:point.knownMinor,cryptoMinor:total.toString(),knownMinor:(BigInt(point.knownMinor)+total).toString(),valuedCount:point.valuedCount+valued.length,missingCount:point.missingCount+crypto.length-valued.length});
        }
        return reply(res,200,history);
      }
      if (req.method === 'POST' && url.pathname === '/api/change') {
        if (req.headers.origin !== origin || !same(req.headers['x-moneywave-csrf'] as string | undefined,csrf)
          || req.headers['content-type'] !== 'application/json') return reply(res,403,{error:'CHANGE_DENIED'});
        const result = await options.store.mutate(await body(req));
        return reply(res,200,result);
      }
      return reply(res,404,{error:'NOT_FOUND'});
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      const allowed = ['SPLIT_REQUIRES_NATIVE_DEBIT','SPLIT_CURRENCY_MISMATCH','SPLIT_TOTAL_MISMATCH','SPLIT_REQUIRES_UNLINKED_EXPENSE','SPLIT_PARENT_ALREADY_LINKED','SPLIT_PURCHASE_INVALID','CASH_ACCOUNT_INVALID','CASH_BEFORE_OPENING','CASH_RATE_UNAVAILABLE','FUTURE_CASH_EXPENSE','CASH_EXPENSE_EXISTS','CASH_EXPENSE_NOT_FOUND','REVISION_CONFLICT','LINK_ALREADY_ASSIGNED','LINK_INVALID','PAYMENT_LINK_INVALID','PAYMENT_ID_DUPLICATE','MANUAL_PAYMENT_WITH_BANK_DEBIT','FUTURE_MANUAL_PAYMENT','ROW_NOT_FOUND','CASH_FX_REQUIRES_DEBIT','CATEGORY_NOT_FOUND','CATEGORY_NAME_TAKEN','CATEGORY_INVALID','PERIOD_INVALID','PERIOD_UNAVAILABLE','NOTHING_TO_UNDO','BODY_TOO_LARGE','WORKSPACE_NOT_INITIALIZED'];
      return reply(res,code === 'REVISION_CONFLICT' ? 409 : 400,{error:allowed.includes(code) ? code : 'REQUEST_FAILED'});
    }
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000;
  return server;
}

import {createNavigation} from './navigation.js';
import {createAmountPrivacy} from './privacy.js';
const amountPrivacy=createAmountPrivacy({root:document.body,button:document.querySelector('#amount-privacy'),storage:{getItem:key=>window.localStorage.getItem(key),setItem:(key,value)=>window.localStorage.setItem(key,value)},window});
/* Local presentation only. Financial aggregates come from the protected server. */
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const euro = (minor, digits=0) => minor === null || minor === undefined ? '—' : `${Number(minor)<0?'−':''}€${new Intl.NumberFormat('uk-UA',{minimumFractionDigits:digits,maximumFractionDigits:digits}).format(Math.abs(Number(minor))/100)}`;
const percent = (v,base) => base > 0 ? `${(v/base*100).toLocaleString('uk-UA',{maximumFractionDigits:2})}%` : '—';
const signedEuro=v=>`${v>0?'+':''}${euro(v)}`;
const categoryName=c=>Object.hasOwn(workspace.state.categoryNames??{},c)?workspace.state.categoryNames[c]:c;
const prettyProvider=v=>String(v).toLowerCase()==='zen'?'ZEN':v;
const date = v => v?.slice(0,10).split('-').reverse().join('.') ?? '—';
const monthNames = ['Січ','Лют','Бер','Кві','Тра','Чер','Лип','Сер','Вер','Жов','Лис','Гру'];
const fullMonths = ['Січень','Лютий','Березень','Квітень','Травень','Червень','Липень','Серпень','Вересень','Жовтень','Листопад','Грудень'];
const pages = {overview:'Огляд',budget:'Бюджет',events:'Поїздки й події',purchases:'Великі покупки',transactions:'Операції'};
let workspace, view, previous, capitalHistory=[], page='overview', period='', category='', query='', allCollections=false, seasonOnly=false, generation=0, modalIds=new Set();
let transactionLimit=80, capitalMode='current', budgetFilter='all', budgetSort='spent', collectionQuery='', collectionKind='all', transactionStatus='all', formBaseline='';
let annualView=null, annualMode='trailing', annualYear='', annualDate='', annualGeneration=0, annualLoading=false, annualError=false;
const selectedCapital=()=>capitalMode==='current'?view.currentCapital:view.capital;
const usd=minor=>minor===null?'—':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(minor/100);
const dialog = $('#dialog');
let navigation, activePanel=null, navigationRender=0, pendingLeave=null;
const navigationDefaults={page:'overview',period:'',capitalMode:'current',category:'',query:'',transactionLimit:80,transactionStatus:'all',budgetFilter:'all',budgetSort:'spent',collectionQuery:'',collectionKind:'all',allCollections:false,seasonOnly:false,annualMode:'trailing',annualYear:'',annualDate:'',annualDetailsOpen:false,panel:null,scroll:0,panelScroll:0,focus:null};
function focusSelector(){
 const el=document.activeElement;if(!el||el===document.body)return null;
 if(el.id)return '#'+CSS.escape(el.id);
 for(const attr of ['data-row','data-category','data-collection','data-budget','data-page','data-period'])if(el.hasAttribute(attr))return `[${attr}="${CSS.escape(el.getAttribute(attr))}"]`;
 return null;
}
function captureNavigation(){return {page,period,capitalMode,category,query,transactionLimit,transactionStatus,budgetFilter,budgetSort,collectionQuery,collectionKind,allCollections,seasonOnly,annualMode,annualYear,annualDate,annualDetailsOpen:$('#screen .annual-details')?.open??false,panel:activePanel,scroll:window.scrollY,panelScroll:$('#drawer').scrollTop,focus:focusSelector()};}
function locationNavigation(){
 const params=new URLSearchParams(location.search),requested=params.get('period');
 const initial=workspace.report.months.filter(m=>!m.partial).at(-1)?.month??workspace.report.months.at(-1)?.month;
 return {...navigationDefaults,page:Object.hasOwn(pages,params.get('page'))?params.get('page'):'overview',period:requested&&workspace.report.months.some(m=>m.month===requested||m.month.slice(0,4)===requested)?requested:initial,capitalMode:['current','period'].includes(params.get('capital'))?params.get('capital'):'current'};
}
function navigationUrl(state){return '?'+new URLSearchParams({page:state.page,period:state.period,capital:state.capitalMode});}
function renderNavigation(){
 const button=$('#navigation-back');if(!button)return;
 const previous=navigation?.previous(),labels={overview:'До огляду',budget:'До бюджету',transactions:'До операцій',events:'До подій',purchases:'До покупок'};
 const target=previous?.page??(page==='transactions'?'budget':'overview');
 button.hidden=!navigation?.canBack()&&page==='overview';button.disabled=!navigation;
 $('#navigation-forward').hidden=!navigation?.canForward();
 button.textContent='← '+(previous?.panel?'Назад':labels[target]);
 $('#chapter').textContent=pages[page]+(page==='transactions'&&category?' / '+categoryName(category):'');
}
function requestLeave(resume){
 pendingLeave=resume;
 const el=$('#discard-changes');el.hidden=false;el.innerHTML='<p>Є незбережені зміни. Залишити цю форму?</p><button class="chip" data-action="keepEditing">Продовжити редагування</button><button class="link red" data-action="discard">Відкинути зміни й повернутися</button>';el.querySelector('button').focus();
}
function clearOverlay(){if(dialog.open)dialog.close();$('#drawer').innerHTML='';formBaseline='';pendingLeave=null;document.body.classList.remove('print-preview');$('#print-report').innerHTML='';}
async function restoreNavigation(state){
 const token=++navigationRender;clearOverlay();
 ({page,capitalMode,category,query,transactionLimit,transactionStatus,budgetFilter,budgetSort,collectionQuery,collectionKind,allCollections,seasonOnly,annualMode,annualYear,annualDate}=state);
 activePanel=state.panel;
 await selectPeriod(state.period);
 if(token!==navigationRender)return;
 if($('#screen .annual-details'))$('#screen .annual-details').open=state.annualDetailsOpen;
 if(activePanel){const p=activePanel;const panels={row:()=>rowEdit(p.id),categoryName:()=>categoryEdit(p.category),categories:categoriesEdit,budget:()=>budgetEdit(p.category??''),collection:()=>collectionEdit(p.id??null,p.kind??'trip'),accounts:()=>showAccounts(p.provider),monthly:showMonthly,costs:showCosts,history:showHistory,print:printReport};try{await panels[p.type]?.();}catch(error){failure(error);}}
 if(token!==navigationRender)return;
 window.scrollTo(0,state.panel?.type==='print'?0:state.scroll);$('#drawer').scrollTop=state.panelScroll??0;
 if(state.focus&&!activePanel)document.querySelector(state.focus)?.focus({preventScroll:true});
 else if(!activePanel)$('#screen h1')?.focus({preventScroll:true});
 renderNavigation();
}
function navigate(patch){return navigation.visit({...captureNavigation(),panel:null,panelScroll:0,scroll:0,focus:null,...patch});}
function showPanel(panel){return navigation.visit({...captureNavigation(),panel,panelScroll:0,focus:null});}
function goBack(){if(navigation.canBack())navigation.back();else navigate({page:page==='transactions'?'budget':'overview',category:'',query:''});}

async function api(path,body) {
  const response = await fetch(path,body ? {method:'POST',headers:{'Content-Type':'application/json','X-Moneywave-Csrf':workspace.csrf},body:JSON.stringify(body)} : {});
  const value = await response.json();
  if(!response.ok) throw new Error(value.error ?? 'REQUEST_FAILED');
  return value;
}
function formError(error){const el=$('#form-error');if(el){el.hidden=false;el.textContent=({CATEGORY_NAME_TAKEN:'Така назва вже є в іншої категорії. Обери іншу.',CATEGORY_NOT_FOUND:'Категорію більше не знайдено. Онови сторінку.',AMOUNT_INVALID:'Вкажи суму з точністю до двох знаків.',MANUAL_PAYMENT_WITH_BANK_DEBIT:'Прибери ручну суму: вже обрано банківську оплату.',REVISION_CONFLICT:'Дані змінилися в іншому вікні. Онови сторінку й повтори правку.'})[error.message]??'Не вдалося зберегти. Перевір поля та спробуй ще раз.';}else failure(error);}
function notice(message) { const n=$('#notice');n.textContent=message;n.hidden=false;n.className='toast';setTimeout(()=>n.hidden=true,4500); }
function failure(error) {
  const messages={DATA_CHANGED:'Дані оновлюються в іншому вікні. Повтори вибір періоду.',FUTURE_MANUAL_PAYMENT:'Майбутню оплату додай як бюджет покупки. Ручна витрата має вже бути сплачена.',REVISION_CONFLICT:'Дані вже змінилися в іншому вікні. Оновлюю; повтори правку.',MANUAL_PAYMENT_WITH_BANK_DEBIT:'Уже обрано банківську оплату. Прибери ручну суму, щоб не врахувати витрату двічі.',LINK_ALREADY_ASSIGNED:'Ця оплата вже належить іншій події або покупці. Спочатку відв’яжи її там.',NOTHING_TO_UNDO:'Останню правку вже скасовано.',SESSION_REQUIRED:'Сесію завершено. Онови сторінку.',WORKSPACE_NOT_INITIALIZED:'Фінансовий звіт ще не підключено.'};
  notice(messages[error.message] ?? 'Не вдалося зберегти або завантажити дані. Спробуй ще раз.');
  if(error.message === 'REVISION_CONFLICT') reload().catch(()=>{});
}
async function reload() { workspace=await api('/api/workspace');await selectPeriod(period); }
async function mutate(change) {
  const buttons=dialog.querySelectorAll('button');buttons.forEach(b=>b.disabled=true);
  try { await api('/api/change',{...change,revision:workspace.revision});await reload();close(true);notice('Збережено на цьому Mac'); }
  catch(error){formError(error);}finally{buttons.forEach(b=>b.disabled=false);}
}
function titlePeriod() { return period.length===4 ? period : `${fullMonths[Number(period.slice(5))-1]} ${period.slice(0,4)}`; }
function renderPeriods() {
 const years=[...new Set(workspace.report.months.map(m=>m.month.slice(0,4)))];const y=period.slice(0,4);
 $('#periods').innerHTML=`<div class="period-picker"><div class="period-top"><div class="year-chips" role="group" aria-label="Роки">${years.map(year=>`<button class="period-chip" data-period="${year}" aria-pressed="${year===y}">${year}</button>`).join('')}</div><span class="period-caption">${view.partial?'Неповний період · ':''}${date([view.months[0].month+'-01',workspace.report.coverage.start].sort().at(-1))} — ${date(view.capital.asOf)}</span></div><div class="month-chips" role="group" aria-label="Місяці"><button class="period-chip whole-year" data-period="${y}" aria-pressed="${period.length===4}">Весь рік</button>${monthNames.map((label,i)=>{const p=`${y}-${String(i+1).padStart(2,'0')}`;return `<button class="period-chip" data-period="${p}" aria-label="${fullMonths[i]} ${y}" aria-pressed="${period===p}" ${workspace.report.months.some(m=>m.month===p)?'':'disabled'}>${label}</button>`;}).join('')}</div></div>`;
}
async function selectPeriod(next) {
 const token=++generation;$('#screen').setAttribute('aria-busy','true');$('#periods').classList.add('loading');
 try {
  let current=workspace,result=await api(`/api/period?period=${encodeURIComponent(next)}`);
  for(let attempt=0;result.revision!==current.revision&&attempt<2;attempt++){current=await api('/api/workspace');result=await api(`/api/period?period=${encodeURIComponent(next)}`);}
  if(result.revision!==current.revision)throw new Error('DATA_CHANGED');
  if(token!==generation)return;
  workspace=current;period=next;view=result;previous=result.comparison;
  await loadAnnualComparison();
  if(token!==generation)return;
  renderPeriods();render();
 }catch(error){failure(error);}finally{if(token===generation){$('#screen').removeAttribute('aria-busy');$('#periods').classList.remove('loading');}}
}
function heading(title, action='') {return `<div class="head"><div><div class="eyebrow">${esc(titlePeriod())}</div><h1 tabindex="-1">${esc(title)}</h1></div>${action}</div>`;}
function line(label,amount,cls='',action='') {return `<${action?'button':'div'} class="line ${cls}" ${action?`data-action="${action}"`:''}><span>${esc(label)}</span><strong>${euro(amount)}</strong></${action?'button':'div'}>`;}
function stats(items) {return `<div class="strip">${items.map(([label,value,cls=''])=>`<div><span class="label">${esc(label)}</span><strong class="${cls}">${value}</strong></div>`).join('')}</div>`;}
function allRows() {
 const trips=new Map();for(const c of workspace.state.collections.filter(c=>c.kind==='trip'))for(const id of c.rowIds)trips.set(id,c.name);
 const base = workspace.report.rows.map(r=>{const edit=workspace.state.overrides[r.id];return {...r,group:trips.has(r.id)?'Відпустки та подорожі':edit?.category??r.homeGroup??r.group,description:edit?.name!==undefined?(edit.name||r.description):(edit?.note||r.description),excluded:edit?.excluded??r.excluded,trip:trips.get(r.id)??null};});
 for(const c of workspace.state.collections)if(c.manualPayment)base.push({id:`user:${c.id}`,date:c.manualPayment.date,eur:c.manualPayment.eur,group:c.kind==='purchase'?'Покупки, техніка, одяг, подарунки, дім':'Відпустки та подорожі',description:c.name,provider:'Ручна оплата',source:'user',sourceRefs:[],trip:c.kind==='trip'?c.name:null,excluded:false});
 return base;
}
function totals(c) {const rows=allRows().filter(r=>(c.rowIds.includes(r.id)||r.id===`user:${c.id}`)&&!r.excluded);return {rows,paid:rows.filter(r=>r.eur>0).reduce((a,r)=>a+r.eur,0),recovered:-rows.filter(r=>r.eur<0).reduce((a,r)=>a+r.eur,0),net:rows.reduce((a,r)=>a+r.eur,0)};}
function chart() {
 let points=capitalHistory.filter(p=>p.asOf<=selectedCapital().asOf);points=period.length===4?points.filter(p=>p.asOf.startsWith(period)):points.slice(-12);
 if(points.length<2)return '<p class="empty">Графік з’явиться, коли є щонайменше два місячні залишки.</p>';
 const values=points.map(p=>Number(p.knownMinor)),lo=Math.min(...values),hi=Math.max(...values),span=hi-lo||1;
 const xy=values.map((v,i)=>`${10+i/(values.length-1)*560},${148-(v-lo)/span*120}`);
 return `<p class="quiet chart-caption">Рахунки й готівка · історія без крипти</p><svg class="chart" viewBox="0 0 580 165" role="img" aria-label="Історія закордонних рахунків і готівки у євро"><path d="M ${xy.join(' L ')}" fill="none" stroke="#087a65" stroke-width="2.5"/>${xy.map((p,i)=>`<circle cx="${p.split(',')[0]}" cy="${p.split(',')[1]}" r="3" fill="#087a65"><title>${date(points[i].asOf)}: ${euro(values[i])}</title></circle>`).join('')}</svg><div class="months"><span>${date(points[0].asOf)}</span><span>${date(points.at(-1).asOf)}</span></div>`;
}
function insights() {
 const overs=view.categories.filter(c=>c.actual>c.plan && c.actual>0).sort((a,b)=>(b.actual-b.plan)-(a.actual-a.plan)).slice(0,3);
 const items=overs.map(c=>`<div class="insight"><div class="insight-num">+${euro(c.actual-c.plan)}</div><div><h3>${esc(categoryName(c.category))}</h3><p>${c.plan?`План ${euro(c.plan)}; факт ${euro(c.actual)}.`:'У поточному бюджеті немає ліміту.'} <button class="link" data-category="${esc(c.category)}">Побачити оплати ↗</button></p></div></div>`);
 if(previous) {
  const food=view.categories.find(c=>c.category==='Продукти'),before=previous.categories.find(c=>c.category==='Продукти');
  if(food && before?.actual>0)items.push(`<div class="insight"><div class="insight-num">${food.actual>=before.actual?'+':''}${percent(food.actual-before.actual,before.actual)}</div><div><h3>${esc(categoryName('Продукти'))} проти ${date(previous.from)}–${date(previous.to)}</h3><p>${euro(before.actual)} → ${euro(food.actual)}. Домашнє харчування; покупки в поїздках включені у подорожі.</p></div></div>`);
 }
 return items.join('')||'<p class="quiet">За цими категоріями перевищення плану немає.</p>';
}
function overview() {
 const c=selectedCapital(), ratio=percent(view.tax+view.bank,view.income);
 const providers=[...new Set(c.positions.map(p=>p.provider))];
 return heading('Огляд')+`<div class="overview"><section class="capital"><div class="capital-title"><h2>Net Worth</h2><button class="link" data-action="accounts">Склад активів ↗</button></div><div class="capital-switch segmented" role="group" aria-label="Дата Net Worth"><button class="chip ${capitalMode==='current'?'on':''}" data-capital-mode="current" aria-pressed="${capitalMode==='current'}">Зараз</button><button class="chip ${capitalMode==='period'?'on':''}" data-capital-mode="period" aria-pressed="${capitalMode==='period'}">На кінець періоду</button></div><div class="total">${euro(c.positions.some(p=>p.reportMinor!==null)||c.crypto.some(p=>p.eurMinor!==null)?c.knownNetMinor:null)}</div><div class="quiet">${capitalMode==='current'?'Останні відомі залишки':'На кінець періоду'} · ${date(c.asOf)}</div>${allocation(c)}<div class="decomposition"><div><strong>${euro(Number(c.knownAssetsMinor)-Number(c.cryptoMinor))}</strong><span>Рахунки й готівка</span></div><div><strong>${euro(c.crypto.some(p=>p.eurMinor!==null)?c.cryptoMinor:null)}</strong><span>Крипто</span></div><div><strong>${euro(c.knownLiabilitiesMinor)}</strong><span>Зобов’язання</span></div></div><details class="method-note"><summary>Дати та повнота активів${c.unvaluedCount?` · без оцінки: ${c.unvaluedCount}`:''}</summary><p class="quiet">Кожен залишок має власну дату в деталях. Акції ще не додані; показано відомі активи та зобов’язання.</p></details>${chart()}</section><section class="cashflow"><div class="eyebrow">Грошовий потік</div><h2>${esc(titlePeriod())}</h2><div class="month-lines">${line('Зароблено',view.manualOnly?null:view.income,'','monthly')}${line('Особисті витрати',view.net,'','spending')}${line('Податки та банк',view.manualOnly?null:view.tax+view.bank,'','costs')}${line('Грошовий залишок',view.manualOnly?null:view.remainder,'total-line','monthly')}</div><p class="quiet">${view.manualOnly?'За цей місяць є лише ручні оплати. Доходи та витрати банку ще не завантажені.':'Після витрат і податків. Приріст рахунків ще не звірено.'}</p><button class="costs cost-button" data-action="costs"><div class="cost-head"><span>Податки + банк</span><strong>${ratio}</strong></div>${line('Сплачені податки',view.manualOnly?null:view.tax)}${line('Комісії, утримання, відсотки',view.manualOnly?null:view.bank)}${line('FX · оцінка до еталонного курсу',view.fx)}<div class="cost-foot"><span>Разом з FX · від заробленого</span><b>${view.fx===null?'—':percent(view.tax+view.bank+view.fx,view.income)}</b></div></button></section></div>${cryptoBox()}<div class="lower"><section class="section"><div class="section-head"><h2>Де лежать гроші</h2><button class="link" data-action="accounts">Деталі ↗</button></div><table class="assets"><tbody>${providers.map(p=>{const positions=c.positions.filter(x=>x.provider===p),known=positions.filter(x=>x.reportMinor!==null);return `<tr><td><button class="asset-name" data-provider="${esc(p)}"><span class="symbol">${esc(p.slice(0,1))}</span><span>${esc(prettyProvider(p))}<span class="subline display-block">${[...new Set(positions.map(x=>x.currency))].join(' · ')}</span></span></button></td><td>${known.length?euro(known.reduce((a,x)=>a+Number(x.reportMinor),0)):'—'}</td></tr>`;}).join('')}</tbody></table></section><section class="section"><div class="section-head"><h2>Що вплинуло на бюджет</h2><button class="link" data-page="budget">План / факт ↗</button></div>${insights()}</section></div><section class="section"><div class="section-head"><h2>AI та інші підписки</h2><button class="link" data-category="AI-сервіси">Усі AI-оплати ↗</button></div>${subscriptionTable()}<p class="quiet">Оплати за період, включно з ZEN. Статус активності підписок не перевірено.</p></section>${view.unknown?`<div class="note">${euro(view.unknown)} переказів без встановленого призначення — поза підтвердженими витратами. Тому грошовий залишок не прирівнюється до заощаджень.</div>`:''}`;
}
function allocation(c) {
 const bank=Math.max(0,Number(c.knownAssetsMinor)-Number(c.cryptoMinor)),cryptoValue=Number(c.cryptoMinor),total=bank+cryptoValue;
 if(!total)return '';
 return `<svg class="allocation" viewBox="0 0 100 4" preserveAspectRatio="none" role="img" aria-label="Частка активів: рахунки ${percent(bank,total)}, крипто ${percent(cryptoValue,total)}"><rect width="100" height="4" class="allocation-bank"/><rect x="${bank/total*100}" width="${cryptoValue/total*100}" height="4" class="allocation-crypto"/></svg>`;
}
function cryptoBox() {
 const c=selectedCapital();
 if(!c.crypto.length)return `<section class="section crypto-section"><div class="section-head"><h2>Крипто</h2></div><p class="quiet">Немає оцінок на цю дату.${capitalMode==='period'?' <button class="link" data-capital-mode="current">Поточні оцінки ↗</button>':''}</p></section>`;
 return `<section class="section crypto-section"><div class="section-head"><div><h2>Крипто</h2><p class="section-caption">Збережені оцінки · включено в Net Worth</p></div><strong>${euro(c.crypto.some(p=>p.eurMinor!==null)?c.cryptoMinor:null)}</strong></div><div class="crypto-grid">${[...c.crypto].sort((a,b)=>Number(b.eurMinor)-Number(a.eurMinor)).map(p=>`<article class="crypto-card"><div class="crypto-top"><span class="crypto-symbol" aria-hidden="true">${p.chain==='near'?'N':'◇'}</span><div><h3>${p.chain==='near'?'NEAR':'Ethereum'}</h3><span class="subline">${p.chain==='near'?esc(p.account):esc(p.account.slice(0,8)+'…'+p.account.slice(-6))}</span></div><div class="crypto-value">${euro(p.eurMinor,2)}<span>${usd(p.usdMinor)}</span></div></div><details class="crypto-details"><summary>Склад активів <span>${p.parts.filter(x=>x.usdMinor>0).map(x=>esc(x.label.split(' · ')[0])).join(' · ')}</span></summary><div class="table-wrap"><table class="data crypto-parts"><thead><tr><th>Актив / складова</th><th>Кількість</th><th>USD</th></tr></thead><tbody>${p.parts.map(part=>`<tr><td>${esc(part.label)}</td><td data-private>${esc(part.quantity??'—')}</td><td>${usd(part.usdMinor)}</td></tr>`).join('')}</tbody></table></div>${p.note?`<p class="quiet">${esc(p.note)}</p>`:''}<p class="quiet">${p.fx?`USD → EUR <span data-private>${esc(p.fx.rate)}</span> · ${esc(p.fx.source)} · ${date(p.fx.publicationDate)}${p.fx.stale?' · курс старший за 7 днів':''}`:'Немає USD → EUR курсу; позиція не включена у EUR-підсумок.'} Складові входять у NAV один раз.</p></details><div class="crypto-footer"><span>Оцінка ${new Date(p.observedAt).toLocaleString('uk-UA',{dateStyle:'short',timeStyle:'short'})}</span><a href="${esc(p.sourceUrl)}" target="_blank" rel="noopener noreferrer">${esc(p.source)} ↗</a></div></article>`).join('')}</div><p class="quiet">Ціни не оновлюються автоматично. Поточні оцінки не переносяться на минулі місяці.</p></section>`;
}
function subscriptionTable() {
 const ai=view.rows.filter(r=>r.group==='AI-сервіси'||r.group==='Інші цифрові підписки');
 const groups=[...new Set(ai.map(r=>r.aiProvider??(r.group==='AI-сервіси'?'Інші AI':'Інші цифрові підписки')))];
 return `<div class="table-wrap"><table class="data"><thead><tr><th>Сервіс</th><th>Оплат</th><th>За період</th><th>Середнє / міс.</th></tr></thead><tbody>${groups.map(g=>{const rows=ai.filter(r=>(r.aiProvider??(r.group==='AI-сервіси'?'Інші AI':'Інші цифрові підписки'))===g),amount=rows.reduce((a,r)=>a+r.eur,0);return `<tr><td>${esc(g)}</td><td>${rows.length}</td><td>${euro(amount,2)}</td><td>${euro(amount/view.months.length,2)}</td></tr>`;}).join('')}</tbody></table></div>`;
}
async function loadAnnualComparison() {
 const token=++annualGeneration;annualLoading=true;annualError=false;
 annualDate ||= workspace.statementCoverage.end;
 annualYear ||= workspace.statementCoverage.end.slice(0,4);
 try {
  const params=new URLSearchParams(annualMode==='calendar'?{mode:annualMode,year:annualYear}:{mode:annualMode,asOf:annualDate});
  const result=await api('/api/annual-comparison?'+params);
  if(token===annualGeneration){if(result.revision!==workspace.revision)throw new Error('REVISION_CONFLICT');annualView=result;}
 }catch(error){if(token===annualGeneration){annualView=null;annualError=true;if(error.message==='REVISION_CONFLICT')failure(error);}}
 finally{if(token===annualGeneration)annualLoading=false;}
}
async function updateAnnualComparison(focusId) {
 annualView=null;annualLoading=true;render();await loadAnnualComparison();
 if(page==='budget'){render();document.getElementById(focusId)?.focus({preventScroll:true});}
}
function annualComparisonBlock() {
 const years=[...new Set(workspace.report.months.filter(m=>!m.manualOnly).map(m=>m.month.slice(0,4)))].reverse();
 const controls=`<div class="toolbar annual-controls"><div class="segmented" role="group" aria-label="Режим порівняння років"><button class="chip ${annualMode==='calendar'?'on':''}" data-annual-mode="calendar" id="annual-calendar" aria-pressed="${annualMode==='calendar'}">Календарний рік</button><button class="chip ${annualMode==='trailing'?'on':''}" data-annual-mode="trailing" id="annual-trailing" aria-pressed="${annualMode==='trailing'}">12 місяців до дати</button></div>${annualMode==='calendar'?`<label>Рік <select class="select" id="annual-year" aria-label="Рік для порівняння">${years.map(y=>`<option value="${y}" ${y===annualYear?'selected':''}>${y} / ${Number(y)-1}</option>`).join('')}</select></label>`:`<label>До дати включно <input class="select" type="date" id="annual-date" value="${annualDate}" min="1901-01-01" max="${new Date().toISOString().slice(0,10)}"></label>`}</div>`;
 const a=annualView;
 const rangeLabel=r=>`${date(r.from)} — ${date(r.to)}`;
 const coverage=r=>r.complete?'Повний період':r.coveredFrom?`Дані за ${date(r.coveredFrom)} — ${date(r.coveredTo)} · неповне покриття`:'Немає виписок за цей період';
 const content=annualLoading?'<p class="quiet" role="status">Оновлюю порівняння…</p>':!a?`<p class="quiet" role="status">${annualError?'Не вдалося завантажити порівняння. Зміни період або онови сторінку.':'Обери період для порівняння.'}</p>`:`<div class="annual-totals"><div><span class="label">Обраний період</span><strong>${euro(a.current.net)}</strong><span>${rangeLabel(a.current)}</span><small>${coverage(a.current)}</small></div><div><span class="label">Попередній рік</span><strong>${euro(a.previous.net)}</strong><span>${rangeLabel(a.previous)}</span><small>${coverage(a.previous)}</small></div><div><span class="label">Зміна витрат</span><strong class="${a.delta>0?'red':a.delta<0?'green':''}">${a.delta===null?'—':signedEuro(a.delta)}</strong><span>${a.percent===null?'Без відсоткового порівняння':`${a.percent>0?'+':''}${a.percent.toLocaleString('uk-UA',{maximumFractionDigits:1})}%`}</span></div></div>${a.delta===null?'<p class="quiet annual-coverage-note">Зміна доступна, коли обидва періоди повністю покриті виписками. Часткові суми показані за наявними даними.</p>':''}${a.current.undatedRefunds||a.previous.undatedRefunds?'<p class="quiet">Для частини повернень відомий лише місяць. Обери межу місяця, щоб отримати точний підсумок.</p>':''}<details class="annual-details"><summary>Порівняти категорії</summary><div class="table-wrap"><table class="data annual-table"><thead><tr><th>Категорія</th><th>Обраний період</th><th>Попередній рік</th><th>Зміна</th></tr></thead><tbody>${a.categories.map(c=>`<tr><td>${esc(categoryName(c.category))}</td><td>${euro(c.current)}</td><td>${euro(c.previous)}</td><td>${c.delta===null?'—':signedEuro(c.delta)}</td></tr>`).join('')}</tbody></table></div></details>`;
 return `<section class="annual-comparison" aria-labelledby="annual-title" aria-busy="${annualLoading}"><div class="section-head"><h2 id="annual-title">Рік до року</h2><span class="quiet">Особисті витрати · EUR</span></div>${controls}${content}</section>`;
}
function budget() {
 const gap=view.net-view.plan;
 const all=[...view.categories],rows=all.filter(c=>budgetFilter!=='over'||c.actual>c.plan).sort((a,b)=>budgetSort==='name'?categoryName(a.category).localeCompare(categoryName(b.category),'uk'):budgetSort==='spent'?b.actual-a.actual:(b.actual-b.plan)-(a.actual-a.plan));
 const over=all.filter(c=>c.actual>c.plan).length;
 return heading('Бюджет',`<div class="head-actions"><button class="chip" data-action="categories">Редагувати категорії</button><button class="button outline" data-action="newBudget">+ Категорія</button></div>`)+stats([['План періоду',euro(view.plan)],['Витрачено',euro(view.net)], [gap>0?'Понад бюджет':'Залишилося',euro(Math.abs(gap)),gap>0?'red':'green']])+annualComparisonBlock()+`<div class="toolbar budget-toolbar"><div class="segmented" role="group" aria-label="Фільтр бюджету"><button class="chip ${budgetFilter==='all'?'on':''}" data-budget-filter="all" aria-pressed="${budgetFilter==='all'}">Усі категорії <span>${all.length}</span></button><button class="chip ${budgetFilter==='over'?'on':''}" data-budget-filter="over" aria-pressed="${budgetFilter==='over'}">Понад план <span>${over}</span></button></div><select class="select" id="budget-sort" aria-label="Сортування бюджету"><option value="overspend" ${budgetSort==='overspend'?'selected':''}>За перевищенням</option><option value="spent" ${budgetSort==='spent'?'selected':''}>За витратами</option><option value="name" ${budgetSort==='name'?'selected':''}>За назвою</option></select></div><p class="quiet">${view.months.length} міс. у плані${view.partial?' · для неповного місяця показано повний ліміт':''}. Податки та банк — в огляді.</p><div class="table-wrap"><table class="data budget-table"><thead><tr><th>Категорія</th><th>План</th><th>Факт</th><th>Різниця</th><th>До попереднього періоду</th><th></th></tr></thead><tbody>${rows.map(c=>{const prev=previous?(previous.categories.find(p=>p.category===c.category)?.actual??0):null,delta=prev===null?null:c.actual-prev;return `<tr><td><button data-category="${esc(c.category)}">${esc(categoryName(c.category))}</button>${c.plan>0?`<meter min="0" max="${c.plan}" value="${Math.max(0,c.actual)}" class="budget-meter ${c.actual>c.plan?'over':''}" aria-label="${esc(categoryName(c.category))}: ${percent(c.actual,c.plan)} бюджету"></meter>`:'<span class="subline display-block">Без ліміту</span>'}</td><td>${euro(c.plan)}</td><td><strong>${euro(c.actual)}</strong></td><td class="${c.actual>c.plan?'red':'muted'}">${signedEuro(c.actual-c.plan)}</td><td>${delta===null?'—':`<span class="${delta>0?'red':'green'}">${signedEuro(delta)}</span><span class="subline display-block">було ${euro(prev)}</span>`}</td><td><button class="edit-button" data-budget="${esc(c.category)}" aria-label="Змінити ліміт: ${esc(categoryName(c.category))}">Змінити</button></td></tr>`;}).join('')}${!rows.length?'<tr><td colspan="6"><div class="empty-state"><h3>Перевищень немає</h3><p>Усі категорії вкладаються у план.</p></div></td></tr>':''}${view.refunds?`<tr><td>Повернення без категорії</td><td>—</td><td>${euro(-view.refunds)}</td><td>—</td><td>—</td><td></td></tr>`:''}</tbody></table></div>${previous?`<p class="quiet">Порівняння з ${date(previous.from)}–${date(previous.to)}.</p>`:''}<section class="section"><h2>Річні резерви</h2><p class="quiet">Ліміти на подорожі, події та покупки всередині бюджету.</p>${reserveTable()}</section><section class="section"><h2>Де можна скоротити</h2>${insights()}</section>`;
}
function reserveTable() {
 const year=period.slice(0,4), kinds=[['Відпустки та подорожі',['trip','event']],['Покупки, техніка, одяг, подарунки, дім',['purchase']]];
 return `<div class="table-wrap"><table class="data"><thead><tr><th>Резерв ${year}</th><th>Ліміт на рік</th><th>Бюджети подій</th><th>Оплачено за рік</th><th>Залишок ліміту</th></tr></thead><tbody>${kinds.map(([cat,kind])=>{const annual=Array.from({length:12},(_,i)=>budgetValue(cat,`${year}-${String(i+1).padStart(2,'0')}`)).reduce((a,b)=>a+b,0),planned=workspace.state.collections.filter(c=>kind.includes(c.kind)&&c.start.startsWith(year)).reduce((a,c)=>a+(c.budget??0),0),actual=allRows().filter(r=>!r.excluded&&r.group===cat&&r.date.startsWith(year)).reduce((a,r)=>a+r.eur,0);return `<tr><td>${esc(categoryName(cat))}</td><td>${euro(annual)}</td><td>${euro(planned)}</td><td>${euro(actual)}</td><td class="${actual>annual?'red':'green'}">${euro(annual-actual)}</td></tr>`;}).join('')}</tbody></table></div>`;
}
function budgetValue(cat,month) { return workspace.state.budgets.filter(b=>b.category===cat&&b.from<=month).sort((a,b)=>b.from.localeCompare(a.from))[0]?.amount??(Object.hasOwn(workspace.report.plan,cat)?workspace.report.plan[cat]:0); }
function collections(kind) {
 const all=workspace.state.collections.filter(c=>kind==='purchase'?c.kind==='purchase':c.kind!=='purchase');
 const selected=all.filter(c=>(!seasonOnly||c.season)&&(collectionKind==='all'||c.kind===collectionKind)&&`${c.name} ${c.note} ${c.start}`.toLocaleLowerCase('uk-UA').includes(collectionQuery.toLocaleLowerCase('uk-UA'))&&(allCollections||c.start.startsWith(period)||c.end.startsWith(period)||totals(c).rows.some(r=>r.date.startsWith(period))||(c.start<view.months[0].month+'-01'&&c.end>view.capital.asOf))).sort((a,b)=>b.start.localeCompare(a.start));
 const total=selected.reduce((a,c)=>a+totals(c).net,0);
 return heading(kind==='purchase'?'Великі покупки':'Поїздки й події',`<button class="button" data-new="${kind}">+ ${kind==='purchase'?'Покупка':'Подія'}</button>`)+`<div class="toolbar collections-toolbar"><div class="segmented" role="group" aria-label="Період записів"><button class="chip ${!allCollections?'on':''}" data-action="periodCollections" aria-pressed="${!allCollections}">${esc(titlePeriod())}</button><button class="chip ${allCollections?'on':''}" data-action="allCollections" aria-pressed="${allCollections}">Усі записи</button></div><button class="chip season-chip ${seasonOnly?'on':''}" data-action="season" aria-pressed="${seasonOnly}">Святковий сезон</button>${kind!=='purchase'?`<select id="collection-kind" class="select" aria-label="Тип події"><option value="all">Усі типи</option><option value="trip" ${collectionKind==='trip'?'selected':''}>Відпустки</option><option value="event" ${collectionKind==='event'?'selected':''}>Івенти</option></select>`:''}<input class="search" id="collection-search" type="search" aria-label="Пошук записів" placeholder="Знайти ${kind==='purchase'?'покупку':'подію або поїздку'}…" value="${esc(collectionQuery)}"></div>`+stats([['Власним коштом',euro(total)],['Записів',selected.length],['Заплановано',euro(selected.reduce((a,c)=>a+(c.budget??0),0))]])+`<div class="event-list">${selected.map(c=>{const t=totals(c),status=!t.rows.length?(c.referenceAmount!==null?'Прив’язати оплату':'Заплановано'):c.budget!==null&&t.net>c.budget?'Понад бюджет':t.recovered?'Є повернення':'Оплачено';return `<button class="event" data-collection="${esc(c.id)}"><div class="event-tile" aria-hidden="true"><b>${c.kind==='purchase'?'◇':c.kind==='trip'?'↗':'◌'}</b><span>${c.start.slice(0,4)}</span></div><div class="event-copy"><h3>${esc(c.name)}</h3><p>${c.dateLabel?esc(c.dateLabel):date(c.start)+(c.end!==c.start?' — '+date(c.end):'')}</p><span class="status ${status==='Понад бюджет'?'pending':''}">${status}</span><span class="subline"> · оплат: ${t.rows.length}</span></div><div class="amount"><b>${t.rows.length?euro(t.net):'—'}</b><span>${c.budget!==null?'план '+euro(c.budget):c.referenceAmount!==null?'у таблиці '+euro(c.referenceAmount):'без ліміту'}</span>${t.recovered?`<span class="green">повернено ${euro(t.recovered)}</span>`:''}</div><span class="event-arrow" aria-hidden="true">↗</span></button>`;}).join('')||`<div class="empty-state"><span class="empty-mark" aria-hidden="true">${kind==='purchase'?'◇':'↗'}</span><h3>${collectionQuery||seasonOnly||collectionKind!=='all'?'Записів не знайдено':'У цьому періоді поки немає записів'}</h3><p>${collectionQuery||seasonOnly||collectionKind!=='all'?'Спробуй інший запит або скинь фільтри.':'Відкрий усю історію або додай новий запис.'}</p><button class="chip" data-action="resetCollections">${collectionQuery||seasonOnly||collectionKind!=='all'?'Скинути фільтри':'Відкрити всі записи'}</button></div>`}</div><p class="quiet">Суми за всіма пов’язаними оплатами й поверненнями запису. У місячному бюджеті — за датою кожного платежу.</p>`;
}
function transactionRows(rows,editable=true) {return rows.map(r=>`<tr class="${r.excluded?'excluded-row':''}"><td>${date(r.date)}</td><td><button ${editable?`data-row="${esc(r.id)}"`:''}>${esc(r.description)}</button><div class="subline">${esc(r.provider)}${r.source!=='ledger'?' · '+(r.source==='report_adjustment'?'повернення / компенсація':r.source==='zen_statement'?'виписка ZEN':'зі звіту'):''}${r.trip?' · '+esc(r.trip):''}${r.excluded?' · поза витратами':''}</div></td><td>${editable?`<button class="category-badge" data-row="${esc(r.id)}" aria-label="Змінити категорію: ${esc(r.description)}">${esc(categoryName(r.group))}</button>`:esc(categoryName(r.group))}</td><td class="${r.eur<0?'green':''}">${euro(r.eur,2)}</td></tr>`).join('');}
function transactionTable(rows) {return `<div class="table-wrap"><table class="data transactions"><thead><tr><th>Дата</th><th>Опис</th><th>Категорія</th><th>EUR за датою</th></tr></thead><tbody>${transactionRows(rows)}</tbody></table></div>`;}
function transactions() {
 const rows=allRows().filter(r=>r.date.startsWith(period)&&(!category||r.group===category)&&(transactionStatus==='all'||(transactionStatus==='spending'?!r.excluded&&r.eur>=0:transactionStatus==='refunds'?!r.excluded&&r.eur<0:r.excluded))&&`${r.description} ${r.provider} ${r.date}`.toLocaleLowerCase('uk-UA').includes(query.toLocaleLowerCase('uk-UA'))).sort((a,b)=>b.date.localeCompare(a.date));
 const filtered=category||query||transactionStatus!=='all';
 return heading('Операції','<button class="chip" data-action="categories">Редагувати категорії</button>')+`<div class="toolbar transaction-toolbar"><input class="search" id="search" type="search" placeholder="Назва, банк або дата…" aria-label="Пошук операцій" value="${esc(query)}"><select class="select" id="category-filter" aria-label="Категорія"><option value="">Усі категорії</option>${categoryOptions(category)}</select><select class="select" id="transaction-status" aria-label="Тип операцій">${[['all','Усі операції'],['spending','Витрати'],['refunds','Повернення'],['excluded','Поза витратами']].map(([v,l])=>`<option value="${v}" ${v===transactionStatus?'selected':''}>${l}</option>`).join('')}</select>${filtered?'<button class="link" data-action="resetTransactions">Скинути</button>':''}</div><div class="results-line"><span>${rows.length} записів${filtered?' · за фільтром':''}</span><strong>${euro(rows.filter(r=>!r.excluded).reduce((a,r)=>a+r.eur,0))}</strong><span class="quiet">Натисни назву або категорію, щоб редагувати</span></div>${rows.length?transactionTable(rows.slice(0,transactionLimit)):`<div class="empty-state"><h3>Операцій не знайдено</h3><p>Зміни період або скинь фільтри.</p>${filtered?'<button class="chip" data-action="resetTransactions">Скинути фільтри</button>':''}</div>`}${rows.length>transactionLimit?`<button class="chip load-more" data-action="more">Показати ще · ${rows.length-transactionLimit} записів</button>`:''}`;
}
function categoryKeys(){return [...new Set([...Object.keys(workspace.report.plan),...workspace.state.budgets.map(b=>b.category),...allRows().map(r=>r.group),...Object.values(workspace.state.overrides).map(r=>r.category)])].sort((a,b)=>categoryName(a).localeCompare(categoryName(b),'uk'));}
function categoryOptions(selected){return [...new Set([...categoryKeys(),...(selected?[selected]:[])])].map(c=>`<option ${c===selected?'selected':''} value="${esc(c)}">${esc(categoryName(c))}</option>`).join('');}
function categoriesEdit(){open('Категорії',`<p class="quiet">Назва спільна для бюджету, операцій та звіту. Ліміти й пов’язані оплати зберігаються.</p><div class="category-list">${categoryKeys().map(c=>`<button class="category-item" data-rename-category="${esc(c)}"><span>${esc(categoryName(c))}</span><span class="subline">Перейменувати ↗</span></button>`).join('')}</div>`);}
function categoryEdit(cat){open('Назва категорії',`<form id="category-form" data-category="${esc(cat)}">${field('Назва категорії',`<input name="name" value="${esc(categoryName(cat))}" maxlength="240" required>`)}<p class="quiet">Застосується до всіх періодів. Суми та належність операцій збережуться.</p><div class="drawer-actions"><button class="button">Зберегти назву</button><button type="button" class="chip" data-action="close">Скасувати</button>${categoryName(cat)!==cat?'<button type="button" class="link" data-action="originalCategoryName">Повернути початкову назву</button>':''}</div></form>`);}

function render() {
 document.querySelectorAll('nav [data-page],#history,#print').forEach(b=>b.disabled=false);
 document.querySelectorAll('[data-page]').forEach(b=>b.classList.toggle('active',b.dataset.page===page));
 $('#chapter').textContent=pages[page];
 renderNavigation();
 document.querySelectorAll('nav [data-page]').forEach(b=>b.setAttribute('aria-current',b.dataset.page===page?'page':'false'));
 $('#screen').innerHTML={overview,budget,events:()=>collections('trip'),purchases:()=>collections('purchase'),transactions}[page]();
 $('#coverage').textContent=`Виписки ${date(workspace.statementCoverage.start)}–${date(workspace.statementCoverage.end)} · правки v${workspace.revision}${workspace.sourceCurrent?'':' · банк змінився: звіт потребує оновлення'}`;
 amountPrivacy.refresh();
 navigation?.remember();
}
function formFingerprint(){const form=dialog.querySelector('form');return form?JSON.stringify([...new FormData(form)])+JSON.stringify([...modalIds].sort()):'';}
function open(title,html) {$('#drawer').innerHTML=`<div class="drawer-head"><button class="dialog-back" data-action="close" aria-label="Назад до попереднього екрана">← Назад</button><h2 id="dialog-title">${esc(title)}</h2><button class="close" data-action="close" aria-label="Закрити">×</button></div>${html}<div id="discard-changes" hidden></div><p id="form-error" class="form-error" role="alert" hidden></p>`;dialog.setAttribute('aria-labelledby','dialog-title');if(!dialog.open)dialog.showModal();formBaseline=formFingerprint();amountPrivacy.refresh();}
function close(force=false){if(navigation?.canBack())navigation.back(force);else{clearOverlay();activePanel=null;render();}}
function field(label,control){return `<label class="field"><span>${esc(label)}</span>${control}</label>`;}
function budgetEdit(cat='') {
 const from=period.length===4?period+'-01':period;
 open('Ліміт бюджету',`<form id="budget-form" data-category="${esc(cat)}">${field('Категорія',cat?`<input name="category" value="${esc(categoryName(cat))}" readonly>`:'<input name="category" required maxlength="240">')}${field('Місячний ліміт, EUR',`<input data-private name="amount" type="number" min="0" max="10000000" step="0.01" value="${(budgetValue(cat,from)/100).toFixed(2)}" required>`)}${field('Діє з місяця',`<input name="from" type="month" value="${from}" required>`)}<p class="quiet">Попередні місяці зберігають свій план. Річний ліміт — сума місячних лімітів.</p><div class="drawer-actions"><button class="button">Зберегти ліміт</button><button type="button" class="chip" data-action="close">Скасувати</button></div></form>`);
}
function rowEdit(id) {
 if(id.startsWith('user:')){collectionEdit(id.slice(5));return;}
 const original=workspace.report.rows.find(r=>r.id===id),r=allRows().find(r=>r.id===id),override=workspace.state.overrides[id];if(!r)return;
 open('Редагувати операцію',`<div class="quiet">${date(r.date)} · ${esc(r.provider)}</div><div class="hero-amount">${euro(r.eur,2)}</div><p>${esc(original.description)}</p><form id="row-form" data-id="${esc(id)}">${field('Категорія',`<select name="category">${categoryOptions(override?.category??r.homeGroup??r.group)}</select>`)}${field('Назва операції',`<input name="name" value="${esc(r.description)}" maxlength="4000" required>`)}${field('Нотатка',`<textarea name="note" maxlength="2000" placeholder="Додаткові деталі">${esc(override?.name!==undefined?override.note:'')}</textarea>`)}<label class="checkline"><input name="excluded" type="checkbox" ${r.excluded?'checked':''}> Виключити з витрат (власний або нерозібраний переказ)</label>${r.trip?`<p class="quiet">У звіті оплата належить поїздці «${esc(r.trip)}». Зміна базової категорії збережеться для деталізації.</p>`:''}<p class="quiet">Правка стосується цієї операції${workspace.report.rows.some(x=>x.purchaseId===id)?' та пов’язаних повернень':''}. Сума, дата й оригінал не змінюються.</p><details><summary>Джерело та оригінальна сума</summary><p class="quiet">${r.nativeMinor?`${esc(new Intl.NumberFormat('uk-UA',{maximumFractionDigits:2}).format(Number(r.nativeMinor)/100))} ${esc(r.currency)}`:r.nativeEur!==null&&r.nativeEur!==undefined?euro(r.nativeEur,2):'EUR-оцінка за датою зі звіту'}</p><p class="quiet">${esc(r.sourceRefs.map(s=>`${s.artifactAlias??s.artifact??'Джерело'} · рядок ${s.row??'—'}`).join('; '))}</p></details><div class="drawer-actions"><button class="button">Зберегти правку</button><button type="button" class="chip" data-action="close">Скасувати</button></div></form>`);
}
function collectionEdit(id,kind='trip') {
 const c=workspace.state.collections.find(c=>c.id===id)??{id:crypto.randomUUID(),kind,name:'',start:view.capital.asOf,end:view.capital.asOf,budget:null,note:'',rowIds:[],season:false,referenceAmount:null};
 const t=totals(c);modalIds=new Set(c.rowIds);
 open(c.name||'Новий запис',`<form id="collection-form" data-id="${esc(c.id)}" data-reference="${c.referenceAmount??''}">${stats([['Сплачено',euro(t.paid,2)],['Повернено',euro(t.recovered,2)],['Власним коштом',euro(t.net,2)]])}${field('Назва',`<input name="name" value="${esc(c.name)}" maxlength="240" required>`)}${field('Тип',`<select name="kind">${[['trip','Відпустка / подорож'],['event','Подія'],['purchase','Велика покупка']].map(([v,l])=>`<option value="${v}" ${v===c.kind?'selected':''}>${l}</option>`).join('')}</select>`)}<div class="form-pair">${field('Дата початку / покупки',`<input name="start" type="date" value="${c.start}" required>`)}${field('Дата завершення',`<input name="end" type="date" value="${c.end}" required>`)}</div>${field('Бюджет, EUR',`<input data-private name="budget" type="number" min="0" max="10000000" step="0.01" value="${c.budget===null?'':(c.budget/100).toFixed(2)}" placeholder="Ще не визначено">`)}${field('Нотатка',`<textarea name="note" maxlength="2000">${esc(c.note)}</textarea>`)}<label class="checkline"><input name="season" type="checkbox" ${c.season?'checked':''}> Святковий сезон</label>${c.referenceAmount!==null?`<p class="quiet">У ручній таблиці: ${euro(c.referenceAmount,2)}. Ця сума сама не створює витрат.</p>`:''}<details><summary>Додати оплату, якої немає у виписках</summary><p class="quiet">Вводь лише фактично сплачену суму. Коли з’явиться банківський запис, прибери цю суму та прив’яжи його. Банківські залишки від ручної оплати не змінюються.</p>${field('Сплачено вручну, EUR',`<input data-private name="manualAmount" type="number" min="0.01" max="10000000" step="0.01" value="${c.manualPayment?(c.manualPayment.eur/100).toFixed(2):''}" placeholder="Без ручної оплати">`)}${field('Дата ручної оплати',`<input name="manualDate" type="date" value="${c.manualPayment?.date??c.start}">`)}</details><h3>Оплати й повернення</h3><p class="quiet">Обери вже наявні операції. Включно з оплатами до поїздки та пізнішими компенсаціями.</p><input class="search full-width" id="link-search" type="search" aria-label="Пошук оплат для прив’язки" placeholder="Назва, банк або YYYY-MM"><div id="link-list"></div><div class="drawer-actions"><button class="button">Зберегти запис</button><button type="button" class="chip" data-action="close">Скасувати</button>${id?`<button type="button" class="link red" data-delete="${esc(id)}">Видалити запис</button>`:''}</div><p class="quiet">Видалення запису не видаляє банківських оплат.</p></form>`);renderLinks('');
}
function renderLinks(search) {
 const rows=allRows().filter(r=>r.source!=='user'&&(modalIds.has(r.id)||(!r.excluded&&`${r.description} ${r.date} ${r.provider}`.toLocaleLowerCase('uk-UA').includes(search.toLocaleLowerCase('uk-UA'))))).sort((a,b)=>Number(modalIds.has(b.id))-Number(modalIds.has(a.id))||b.date.localeCompare(a.date));
 $('#link-list').innerHTML=`<p class="quiet">Обрано ${modalIds.size} · ${euro(rows.filter(r=>modalIds.has(r.id)).reduce((a,r)=>a+r.eur,0),2)}</p><div class="link-options">${rows.slice(0,Math.max(60,modalIds.size+20)).map(r=>`<label class="link-option"><input type="checkbox" data-link-id="${esc(r.id)}" ${modalIds.has(r.id)?'checked':''}><span>${esc(r.description)}<small>${date(r.date)} · ${esc(r.provider)}</small></span><b>${euro(r.eur,2)}</b></label>`).join('')}</div><p class="quiet">${rows.length>60?'Уточни пошук, щоб знайти інші оплати.':''}</p>`;
}
function showAccounts(provider) {
 const c=selectedCapital(), positions=c.positions.filter(p=>!provider||p.provider===provider);
 open(provider||'Склад Net Worth',`<p class="quiet">Закордонні рахунки й готівка. Оцінка на ${date(c.asOf)}. Старий залишок переноситься до новішого підтвердження.</p>${positions.map(p=>`<details class="account-detail"><summary><span>${esc(p.name)}<small>${esc(p.provider)} · ${p.currency} · ${p.scope==='SOLE_PROPRIETOR'?'ФОП':'особистий'}</small></span><b>${euro(p.reportMinor,2)}</b></summary><div class="quiet"><p>Залишок: ${p.nativeMinor===null?'невідомий':esc(new Intl.NumberFormat('uk-UA',{maximumFractionDigits:2}).format(Number(p.nativeMinor)/100))+' '+esc(p.currency)} · дата ${p.precision==='month'?esc(p.observedAt):date(p.observedAt)}</p><p>${p.status==='known'?'Оцінено':p.status==='conflict'?'Суперечливі джерела':p.status==='missing_rate'?'Бракує курсу':'Бракує залишку'} · ${p.carriedForward?'перенесено з попередньої дати':'на дату звіту'}</p><p>Курс <span data-private>${esc(p.rate??'—')}</span> · ${esc(p.rateSource??'—')} · ${date(p.publicationDate)}${p.rateStale?' · старший за 7 днів':''}</p></div></details>`).join('')}<p class="quiet">Крипто показано окремим блоком і враховано в загальному Net Worth. Акції ще не додані.</p>`);
}
function showMonthly() {
 open('Грошовий результат',`<p class="quiet">Компенсації зменшують особисті витрати, власні перекази не збільшують зароблений дохід. Грошовий залишок не прирівнюється до приросту капіталу.</p><div class="table-wrap"><table class="data"><thead><tr><th>Місяць</th><th>Зароблено</th><th>Витрати</th><th>Податки + банк</th><th>Залишок</th></tr></thead><tbody>${view.months.map(m=>{const current=allRows().filter(r=>!r.excluded&&r.date.startsWith(m.month)).reduce((a,r)=>a+r.eur,0)-(m.grossSpending-m.netSpending);return `<tr><td>${m.month}</td><td>${euro(m.manualOnly?null:m.income)}</td><td>${euro(current)}</td><td>${euro(m.manualOnly?null:m.tax+m.bank)}</td><td>${euro(m.manualOnly?null:m.income-current-m.tax-m.bank)}</td></tr>`;}).join('')}</tbody></table></div><p class="quiet">${view.unknown?`Ще ${euro(view.unknown)} переказів без встановленого призначення. `:''}Усі суми — EUR за датами операцій; місяць без надходження може містити заробіток, виплачений у сусідньому місяці.</p>`);
}
function showCosts() {
 open('Податки, банк і FX',stats([['Від заробленого',percent(view.tax+view.bank,view.income)],['Сплачено',euro(view.tax+view.bank,2)]])+line('Податки',view.tax)+line('Банк: комісії, утримання, відсотки',view.bank)+line('FX-відхилення від еталонного курсу',view.fx)+`<div class="note">Податки + банк: ${percent(view.tax+view.bank,view.income)}. Разом з оцінкою FX: ${view.fx===null?'немає повної оцінки':percent(view.tax+view.bank+view.fx,view.income)}.</div><p class="quiet">База: зароблено ${euro(view.income,2)} за ${esc(titlePeriod())}; компенсації роботодавця виключені. Комісії PrivatBank, Monobank, Erste, ZEN та зіставлені утримання включені до банківських витрат.</p><p class="quiet">FX — відхилення від офіційного курсу для проаналізованих обмінів. Це оцінка вартості обміну, не окреме списання; до грошових витрат повторно не додається. Непояснені різниці не називаються комісіями.</p><div class="table-wrap"><table class="data"><thead><tr><th>Дата</th><th>Складова</th><th>EUR</th></tr></thead><tbody>${view.costRows.map(r=>`<tr><td>${date(r.date)}</td><td>${esc(r.label)}</td><td>${euro(r.eur,2)}</td></tr>`).join('')}</tbody></table></div>`);
}
async function showHistory() {
 const records=await api('/api/history');
 const labels={row:'Назва та категорія операції',categoryName:'Назва категорії',budget:'Ліміт бюджету',collection:'Подія або покупка',deleteCollection:'Видалення запису',undo:'Скасування правки',report_refresh:'Оновлення фінансового звіту',gift_category_split:'Подарунки — окрема категорія'};
 open('Історія правок',`<p class="quiet">Оригінали збережені. Можна скасувати останню зміну.</p>${records[0]&&!['undo','report_refresh'].includes(records[0].action)?'<button class="button outline" data-action="undo">Скасувати останню правку</button>':''}${records.map(r=>`<div class="line"><span>${esc(labels[r.action]??r.action)}<small class="subline display-block">${new Date(r.createdAt).toLocaleString('uk-UA')}</small></span><b>v${r.revision}</b></div>`).join('')||'<p class="empty">Ручних змін ще немає.</p>'}`);
}
function printReport() {
 const priorPage=page,priorAll=allCollections,priorSeason=seasonOnly,priorQuery=collectionQuery,priorKind=collectionKind,priorBudgetFilter=budgetFilter;allCollections=false;seasonOnly=false;collectionQuery='';collectionKind='all';budgetFilter='all';$('#print-report').innerHTML=`<div class="print-title">MoneyWave · ${esc(titlePeriod())}</div>${overview()}<div class="print-break"></div>${budget()}<div class="print-break"></div>${collections('trip')}<div class="print-break"></div>${collections('purchase')}<p class="quiet">Джерела: ${date(workspace.report.coverage.start)}–${date(workspace.report.coverage.end)} · поточна версія правок ${workspace.revision}. Всі суми EUR.</p>`;
 page=priorPage;allCollections=priorAll;seasonOnly=priorSeason;collectionQuery=priorQuery;collectionKind=priorKind;budgetFilter=priorBudgetFilter;
 $('#print-report').querySelectorAll('details').forEach(d=>d.open=true);
 $('#print-report').querySelectorAll('button,input,select').forEach(b=>b.disabled=true);
 $('#print-report').insertAdjacentHTML('afterbegin','<div class="print-actions"><button class="chip" id="print-back">← Назад до сайту</button><button class="button" id="print-save">Зберегти PDF / Друк</button></div>');
 document.body.classList.add('print-preview');window.scrollTo(0,0);
 $('#print-back').addEventListener('click',()=>close());
 $('#print-save').addEventListener('click',()=>window.print());
}
function toCents(value){ const s=String(value);if(!/^\d+(?:\.\d{1,2})?$/.test(s))throw new Error('AMOUNT_INVALID');const [a,b='']=s.split('.');return Number(a)*100+Number(b.padEnd(2,'0')); }
document.addEventListener('click',async event=>{
 const b=event.target.closest('button');if(!b||b.disabled)return;
 if(b.dataset.page){if(b.dataset.page!==page)await navigate({page:b.dataset.page,query:'',category:'',collectionQuery:'',collectionKind:'all',transactionStatus:'all',allCollections:false,seasonOnly:false,transactionLimit:80});return;}
 if(b.dataset.annualMode){annualMode=b.dataset.annualMode;await updateAnnualComparison(b.id);return;}
 if(b.dataset.period){if(b.dataset.period!==period)await navigate({period:b.dataset.period});document.querySelector(`[data-period="${b.dataset.period}"]`)?.focus({preventScroll:true});return;}
 if(b.dataset.budgetFilter){budgetFilter=b.dataset.budgetFilter;render();document.querySelector(`[data-budget-filter="${budgetFilter}"]`)?.focus({preventScroll:true});return;}
 if(b.dataset.category){await navigate({page:'transactions',category:b.dataset.category,query:'',transactionStatus:'all',transactionLimit:80});return;}
 if(b.dataset.renameCategory){showPanel({type:'categoryName',category:b.dataset.renameCategory});return;}
 if(b.dataset.budget){showPanel({type:'budget',category:b.dataset.budget});return;}
 if(b.dataset.row){showPanel({type:'row',id:b.dataset.row});return;}
 if(b.dataset.collection){showPanel({type:'collection',id:b.dataset.collection});return;}
 if(b.dataset.new){showPanel({type:'collection',kind:b.dataset.new});return;}
 if(b.dataset.capitalMode){capitalMode=b.dataset.capitalMode;render();return;}
 if(b.dataset.provider){showPanel({type:'accounts',provider:b.dataset.provider});return;}
 if(b.dataset.delete){await mutate({action:'deleteCollection',id:b.dataset.delete});return;}
 const actions={back:goBack,forward:()=>navigation.forward(),categories:()=>showPanel({type:'categories'}),originalCategoryName:()=>{dialog.querySelector('[name=name]').value=dialog.querySelector('form').dataset.category;},close:()=>close(),discard:()=>{const resume=pendingLeave;pendingLeave=null;if(resume)resume();else close(true);},keepEditing:()=>{pendingLeave=null;$('#discard-changes').hidden=true;dialog.querySelector('input,select')?.focus();},resetTransactions:()=>{category='';query='';transactionStatus='all';render();$('#search').focus();},resetCollections:()=>{collectionQuery='';seasonOnly=false;collectionKind='all';allCollections=true;render();},accounts:()=>showPanel({type:'accounts'}),monthly:()=>showPanel({type:'monthly'}),costs:()=>showPanel({type:'costs'}),spending:()=>navigate({page:'transactions',category:'',query:'',transactionStatus:'all',transactionLimit:80}),newBudget:()=>showPanel({type:'budget'}),allCollections:()=>{allCollections=true;render();},periodCollections:()=>{allCollections=false;render();},season:()=>{seasonOnly=!seasonOnly;render();},more:()=>{transactionLimit+=80;render();},undo:()=>mutate({action:'undo'})};
 if(actions[b.dataset.action])await actions[b.dataset.action]();
});
document.addEventListener('input',event=>{
 if(event.target.id==='search'){const caret=event.target.selectionStart;query=event.target.value;transactionLimit=80;$('#screen').innerHTML=transactions();$('#search').focus();$('#search').setSelectionRange(caret,caret);navigation.remember();}
 if(event.target.id==='link-search')renderLinks(event.target.value);
 if(event.target.id==='collection-search'){const caret=event.target.selectionStart;collectionQuery=event.target.value;$('#screen').innerHTML=collections(page==='purchases'?'purchase':'trip');$('#collection-search').focus();$('#collection-search').setSelectionRange(caret,caret);navigation.remember();}
});
document.addEventListener('change',async event=>{
 if(event.target.id==='annual-year'){annualYear=event.target.value;await updateAnnualComparison('annual-year');return;}
 if(event.target.id==='annual-date'){if(!event.target.value||!event.target.checkValidity())return;annualDate=event.target.value;await updateAnnualComparison('annual-date');return;}
 if(event.target.id==='budget-sort'){budgetSort=event.target.value;render();$('#budget-sort').focus();}
 if(event.target.id==='collection-kind'){collectionKind=event.target.value;render();$('#collection-kind').focus();}
 if(event.target.id==='transaction-status'){transactionStatus=event.target.value;transactionLimit=80;render();$('#transaction-status').focus();}
 if(event.target.id==='category-filter'){category=event.target.value;transactionLimit=80;render();$('#category-filter').focus();}
 if(event.target.dataset.linkId){if(event.target.checked)modalIds.add(event.target.dataset.linkId);else modalIds.delete(event.target.dataset.linkId);renderLinks($('#link-search').value);}
});
document.addEventListener('submit',async event=>{
 event.preventDefault();const form=event.target,data=new FormData(form);
 try{
 if(form.id==='budget-form')await mutate({action:'budget',category:form.dataset.category||categoryKeys().find(c=>categoryName(c).toLocaleLowerCase('uk')===String(data.get('category')).trim().toLocaleLowerCase('uk'))||data.get('category'),from:data.get('from'),amount:toCents(data.get('amount'))});
 if(form.id==='category-form')await mutate({action:'categoryName',category:form.dataset.category,name:data.get('name')});
 if(form.id==='row-form')await mutate({action:'row',id:form.dataset.id,category:data.get('category'),name:data.get('name'),note:data.get('note'),excluded:data.has('excluded')});
 if(form.id==='collection-form')await mutate({action:'collection',collection:{...(workspace.state.collections.find(c=>c.id===form.dataset.id&&c.start===data.get('start')&&c.end===data.get('end'))?.dateLabel?{dateLabel:workspace.state.collections.find(c=>c.id===form.dataset.id).dateLabel}:{}),id:form.dataset.id,name:data.get('name'),kind:data.get('kind'),start:data.get('start'),end:data.get('end'),budget:data.get('budget')===''?null:toCents(data.get('budget')),note:data.get('note'),season:data.has('season'),rowIds:[...modalIds],manualPayment:data.get('manualAmount')?{date:data.get('manualDate'),eur:toCents(data.get('manualAmount'))}:null,referenceAmount:form.dataset.reference===''?null:Number(form.dataset.reference)}});
 }catch(error){formError(error);}
});
$('#history').addEventListener('click',()=>showPanel({type:'history'}));$('#print').addEventListener('click',()=>showPanel({type:'print'}));
dialog.addEventListener('click',event=>{if(event.target===dialog)close();});
dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
window.addEventListener('beforeunload',event=>{if(dialog.open&&formBaseline!==formFingerprint()){event.preventDefault();event.returnValue='';}});
async function start(){
 try{
  workspace=await api('/api/workspace');
  const initial=locationNavigation();
  ({page,period,capitalMode}=initial);
  history.scrollRestoration='manual';
  navigation=createNavigation({history,listen:handler=>window.addEventListener('popstate',handler),capture:captureNavigation,restore:restoreNavigation,fallback:locationNavigation,url:navigationUrl,dirty:()=>dialog.open&&formBaseline!==formFingerprint(),confirm:requestLeave,changed:renderNavigation});
  navigation.start(captureNavigation());
  await selectPeriod(period);capitalHistory=await api('/api/capital-history');render();
 }catch(error){$('#screen').innerHTML='<p class="empty">Не вдалося відкрити дані. Онови сторінку після запуску локального сервера.</p>';failure(error);}
}
start();

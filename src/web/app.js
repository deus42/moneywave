import {createNavigation} from './navigation.js';
import {createAmountPrivacy} from './privacy.js';
const amountPrivacy=createAmountPrivacy({root:document.body,button:document.querySelector('#amount-privacy'),storage:{getItem:key=>window.localStorage.getItem(key),setItem:(key,value)=>window.localStorage.setItem(key,value)},window});
/* Local presentation only. Financial aggregates come from the protected server. */
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const euro = (minor, digits=0) => minor === null || minor === undefined ? '—' : `${Number(minor)<0?'−':''}€${new Intl.NumberFormat('uk-UA',{minimumFractionDigits:digits,maximumFractionDigits:digits}).format(Math.abs(Number(minor))/100)}`;
const percent = (v,base) => base > 0 ? `${(v/base*100).toLocaleString('uk-UA',{maximumFractionDigits:2})}%` : '—';
const signedEuro=v=>`${v>0?'+':''}${euro(v,v!==0&&Math.abs(v)<100?2:0)}`;
const categoryName=c=>Object.hasOwn(workspace.state.categoryNames??{},c)?workspace.state.categoryNames[c]:c;
const operationLabels={expense:'Витрата / повернення',cash_fx:'Купівля валюти готівкою',fx:'Купівля валюти',excluded:'Інший переказ / поза витратами'};
const rowOperationType=r=>r.operationType??(r.excluded?'excluded':'expense');
const rowCategoryLabel=r=>rowOperationType(r)==='expense'?categoryName(r.group):operationLabels[rowOperationType(r)];
const prettyProvider=v=>String(v).toLowerCase()==='zen'?'ZEN':v;
const date = v => v?.slice(0,10).split('-').reverse().join('.') ?? '—';
const monthNames = ['Січ','Лют','Бер','Кві','Тра','Чер','Лип','Сер','Вер','Жов','Лис','Гру'];
const fullMonths = ['Січень','Лютий','Березень','Квітень','Травень','Червень','Липень','Серпень','Вересень','Жовтень','Листопад','Грудень'];
const pages = {overview:'Огляд',budget:'Бюджет',cash:'Готівка',events:'Поїздки',purchases:'Покупки',transactions:'Операції'};
let workspace, view, previous, capitalHistory=[], page='overview', period='', category='', query='', allCollections=false, seasonOnly=false, generation=0, selectedRowIds=new Set();
let transactionLimit=80, budgetFilter='all', budgetSort='overspend', collectionQuery='', collectionKind='all', transactionStatus='all', formBaseline='';
const selectedCapital=()=>view.capital;
const inPeriod=value=>value.slice(0,7)>=view.range.from.slice(0,7)&&value.slice(0,7)<=view.range.to.slice(0,7);
const calendarMonths=()=>workspace.calendar?.months??workspace.report.months.map(m=>m.month);
const validPeriod=value=>value==='all'||value==='last12'||calendarMonths().some(m=>m===value||m.slice(0,4)===value);
const nativeAmount=r=>r.nativeMinor!=null&&r.currency?`${new Intl.NumberFormat('uk-UA',{maximumFractionDigits:2}).format(Math.abs(Number(r.nativeMinor))/100)} ${r.currency}`:null;
const usd=minor=>minor===null?'—':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(minor/100);
const detailPage = $('#detail-page');
let navigation, activePanel=null, navigationRender=0, pendingLeave=null;
const navigationDefaults={page:'overview',period:'',category:'',query:'',transactionLimit:80,transactionStatus:'all',budgetFilter:'all',budgetSort:'overspend',collectionQuery:'',collectionKind:'all',allCollections:false,seasonOnly:false,panel:null,scroll:0,focus:null};
function focusSelector(){
 const el=document.activeElement;if(!el||el===document.body)return null;
 if(el.id)return '#'+CSS.escape(el.id);
 for(const attr of ['data-row','data-category','data-collection','data-budget','data-page','data-period'])if(el.hasAttribute(attr))return `[${attr}="${CSS.escape(el.getAttribute(attr))}"]`;
 return null;
}
function captureNavigation(){return {page,period,category,query,transactionLimit,transactionStatus,budgetFilter,budgetSort,collectionQuery,collectionKind,allCollections,seasonOnly,panel:activePanel,scroll:window.scrollY,focus:focusSelector()};}
function locationNavigation(){
 const params=new URLSearchParams(location.search),requested=params.get('period');
 return {...navigationDefaults,page:Object.hasOwn(pages,params.get('page'))?params.get('page'):'overview',period:validPeriod(requested)?requested:'all'};
}
function navigationUrl(state){return '?'+new URLSearchParams({page:state.page,period:state.period});}
function renderNavigation(){
 const button=$('#navigation-back');if(!button)return;
 const previous=navigation?.previous(),labels={overview:'До огляду',budget:'До бюджету',cash:'До готівки',transactions:'До операцій',events:'До подій',purchases:'До покупок'};
 const target=previous?.page??(page==='transactions'?'budget':'overview');
 button.hidden=!activePanel&&!(page==='transactions'&&category);button.disabled=!navigation;
 $('#navigation-forward').hidden=!navigation?.canForward();
 button.textContent='← '+(previous?.panel?'Назад':labels[target]);
}
function requestLeave(resume){
 pendingLeave=resume;
 const el=$('#discard-changes');el.hidden=false;el.innerHTML='<p>Є незбережені зміни. Залишити цю форму?</p><button class="chip" data-action="keepEditing">Продовжити редагування</button><button class="link red" data-action="discard">Відкинути зміни й повернутися</button>';el.querySelector('button').focus();
}
function clearDetail(){detailPage.hidden=true;detailPage.innerHTML='';$('#screen').hidden=false;$('#periods').hidden=false;$('#page-heading').hidden=false;formBaseline='';pendingLeave=null;document.body.classList.remove('print-preview');$('#print-report').innerHTML='';}
async function restoreNavigation(state){
 const token=++navigationRender;clearDetail();
 ({page,category,query,transactionLimit,transactionStatus,budgetFilter,budgetSort,collectionQuery,collectionKind,allCollections,seasonOnly}=state);
 activePanel=state.panel;
 await selectPeriod(state.period);
 if(token!==navigationRender)return;
 if(activePanel){const p=activePanel;const panels={cashExpense:()=>cashExpenseEdit(p.id),row:()=>rowEdit(p.id),operationSplit:()=>operationSplitEdit(p.id),categoryName:()=>categoryEdit(p.category),categories:categoriesEdit,budget:()=>budgetEdit(p.category??''),collection:()=>collectionEdit(p.id??null,p.kind??'trip'),collectionSettings:()=>collectionEdit(p.id,'trip',true),payment:()=>paymentEdit(p.collectionId,p.id),accounts:()=>showAccounts(p.provider),crypto:()=>open('Крипто',cryptoBox()),monthly:showMonthly,costs:showCosts,savings:showSavings,history:showHistory,print:printReport};try{await panels[p.type]?.();}catch(error){failure(error);}}
 if(token!==navigationRender)return;
 window.scrollTo(0,state.panel?.type==='print'?0:state.scroll);
 const focus=state.focus?document.querySelector(state.focus):null;
 if(focus?.getClientRects().length)focus.focus({preventScroll:true});
 else (activePanel?.type==='cashExpense'?$('#cash-amount'):activePanel?$('#detail-title'):$('#page-heading h1'))?.focus({preventScroll:true});
 renderNavigation();
}
function navigate(patch){return navigation.visit({...captureNavigation(),panel:null,scroll:0,focus:null,...patch});}
function showPanel(panel){
 const sameTrip=panel.type==='collection'&&activePanel?.type==='collection'&&activePanel.id===panel.id;
 return navigation.visit({...captureNavigation(),panel,scroll:sameTrip?window.scrollY:0,focus:null});
}
function goBack(){if(navigation.canBack())navigation.back();else navigate({page:page==='transactions'?'budget':'overview',category:'',query:''});}

async function api(path,body) {
  const response = await fetch(path,body ? {method:'POST',headers:{'Content-Type':'application/json','X-Moneywave-Csrf':workspace.csrf},body:JSON.stringify(body)} : {});
  const value = await response.json();
  if(!response.ok) throw new Error(value.error ?? 'REQUEST_FAILED');
  return value;
}
function formError(error){const el=$('#form-error');if(el){el.hidden=false;el.textContent=({SPLIT_TOTAL_MISMATCH:'Сума частин має точно дорівнювати списанню.',SPLIT_PARENT_ALREADY_LINKED:'Спочатку прибери прив’язку повного списання до покупки чи події.',SPLIT_PURCHASE_INVALID:'Частину витрат можна прив’язати лише до наявної покупки без ручної оплати. Прибери прив’язку перед видаленням покупки.',SPLIT_REQUIRES_UNLINKED_EXPENSE:'Розподіл доступний для витрати без пов’язаних повернень.',SPLIT_REQUIRES_NATIVE_DEBIT:'Потрібна точна сума списання у валюті рахунку.',SPLIT_CURRENCY_MISMATCH:'Валюта розподілу має збігатися з валютою списання.',CASH_RATE_UNAVAILABLE:'Немає підтвердженого курсу EUR на цю дату. Витрату ще не збережено; введені дані залишилися у формі.',CASH_ACCOUNT_INVALID:'Готівковий рахунок недоступний. Обери інший.',CASH_BEFORE_OPENING:'Ця дата передує початку обліку вибраного рахунку.',FUTURE_CASH_EXPENSE:'Вкажи сьогоднішню або минулу дату.',CASH_EXPENSE_EXISTS:'Цю витрату вже збережено. Відкрий її в Операціях.',CASH_EXPENSE_NOT_FOUND:'Цю витрату вже видалено. Онови сторінку.',CATEGORY_NAME_TAKEN:'Така назва вже є в іншої категорії. Обери іншу.',CATEGORY_NOT_FOUND:'Категорію більше не знайдено. Онови сторінку.',AMOUNT_INVALID:'Вкажи суму з точністю до двох знаків.',MANUAL_PAYMENT_WITH_BANK_DEBIT:'Прибери ручну суму: вже обрано банківську оплату.',PAYMENT_LINK_INVALID:'Оплата з таблиці пов’язана з банківським записом. Збережи його прив’язку, щоб уникнути дублювання.',PAYMENT_ID_DUPLICATE:'Ця оплата вже є в записі.',REVISION_CONFLICT:'Дані змінилися в іншому вікні. Онови сторінку й повтори правку.'})[error.message]??'Не вдалося зберегти. Перевір поля та спробуй ще раз.';}else failure(error);}
function notice(message) { const n=$('#notice');n.textContent=message;n.hidden=false;n.className='toast';setTimeout(()=>n.hidden=true,4500); }
function failure(error) {
  const messages={DATA_CHANGED:'Дані оновлюються в іншому вікні. Повтори вибір періоду.',FUTURE_MANUAL_PAYMENT:'Майбутню оплату додай як бюджет покупки. Ручна витрата має вже бути сплачена.',REVISION_CONFLICT:'Дані вже змінилися в іншому вікні. Оновлюю; повтори правку.',MANUAL_PAYMENT_WITH_BANK_DEBIT:'Уже обрано банківську оплату. Прибери ручну суму, щоб не врахувати витрату двічі.',LINK_ALREADY_ASSIGNED:'Ця оплата вже належить іншій події або покупці. Спочатку відв’яжи її там.',NOTHING_TO_UNDO:'Останню правку вже скасовано.',SESSION_REQUIRED:'Сесію завершено. Онови сторінку.',WORKSPACE_NOT_INITIALIZED:'Фінансовий звіт ще не підключено.'};
  notice(messages[error.message] ?? 'Не вдалося зберегти або завантажити дані. Спробуй ще раз.');
  if(error.message === 'REVISION_CONFLICT') reload().catch(()=>{});
}
async function reload() { workspace=await api('/api/workspace');capitalHistory=await api('/api/capital-history');await selectPeriod(period); }
async function mutate(change) {
  const buttons=detailPage.querySelectorAll('button');buttons.forEach(b=>b.disabled=true);
  try { await api('/api/change',{...change,revision:workspace.revision});await reload();close(true);notice('Збережено'); }
  catch(error){formError(error);}finally{buttons.forEach(b=>b.disabled=false);}
}
function titlePeriod() { return period==='all'?'Весь період':period==='last12'?'Останні 12 місяців':period.length===4 ? period : `${fullMonths[Number(period.slice(5))-1]} ${period.slice(0,4)}`; }
const periodIcons={prev:'<path d="m15 18-6-6 6-6"/>',next:'<path d="m9 18 6-6-6-6"/>',down:'<path d="m6 9 6 6 6-6"/>',check:'<path d="M20 6 9 17l-5-5"/>',calendar:'<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4M17 3v4M3 11h18"/>'};
const periodIcon=(name,cls='')=>`<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${periodIcons[name]}</svg>`;
function periodCalendar(year) {
 const years=[...new Set(calendarMonths().map(m=>m.slice(0,4)))],index=years.indexOf(year),today=view.currentCapital.asOf.slice(0,7);
 const inRange=p=>period==='last12'&&p>=view.range.from.slice(0,7)&&p<=view.range.to.slice(0,7);
 return `<div class="period-calendar-heading"><button type="button" class="period-year-step" data-calendar-year="${years[index-1]??''}" aria-label="Попередній рік" ${index>0?'':'disabled'}>${periodIcon('prev')}</button><strong aria-live="polite">${year}</strong><button type="button" class="period-year-step" data-calendar-year="${years[index+1]??''}" aria-label="Наступний рік" ${index>=0&&index<years.length-1?'':'disabled'}>${periodIcon('next')}</button></div><button class="period-option period-year-option" data-period="${year}" aria-pressed="${period===year}">Весь ${year} рік</button><div class="period-month-grid" role="group" aria-label="Місяці ${year}">${monthNames.map((label,i)=>{const p=`${year}-${String(i+1).padStart(2,'0')}`;return `<button class="period-option period-month${p===today?' is-current':''}${inRange(p)?' in-range':''}" data-period="${p}" aria-label="${fullMonths[i]} ${year}" aria-pressed="${period===p}" ${validPeriod(p)?'':'disabled'}>${label}</button>`;}).join('')}</div>`;
}
function renderPeriods() {
 const years=[...new Set(calendarMonths().map(m=>m.slice(0,4)))],today=view.currentCapital.asOf,currentMonth=today.slice(0,7),currentYear=today.slice(0,4);
 const priorMonth=new Date(Date.UTC(Number(currentYear),Number(today.slice(5,7))-2,1)).toISOString().slice(0,7);
 const year=/^\d{4}/.test(period)?period.slice(0,4):years.includes(currentYear)?currentYear:years.at(-1);
 const short=m=>`${monthNames[Number(m.slice(5))-1]} ${m.slice(0,4)}`;
 const choices=[['Цей місяць',currentMonth,short(currentMonth)],['Минулий місяць',priorMonth,short(priorMonth)],['Цей рік',currentYear,currentYear],['Останні 12 місяців','last12','12 міс.'],['Весь період','all',`з ${years[0]}`]];
 const adjacent=period.length===4?years:calendarMonths(),index=adjacent.indexOf(period),prev=adjacent[index-1],next=index>=0?adjacent[index+1]:null;
 $('#periods').innerHTML=`<div class="period-toolbar"><div class="period-control"><div class="period-bar"><button id="period-previous" class="period-step" data-period="${prev??''}" aria-label="Попередній період" ${prev?'':'disabled'}>${periodIcon('prev')}</button><button id="period-trigger" class="period-trigger" data-action="periodPicker" aria-haspopup="dialog" aria-expanded="false" aria-controls="period-popover">${periodIcon('calendar','period-icon')}<span class="period-trigger-text"><strong>${esc(titlePeriod())}</strong><small>${date(view.range.from)} — ${date(view.range.to)}</small></span>${periodIcon('down','period-chevron')}</button><button id="period-next" class="period-step" data-period="${next??''}" aria-label="Наступний період" ${next?'':'disabled'}>${periodIcon('next')}</button></div><div id="period-popover" class="period-popover" role="dialog" aria-label="Вибрати період" hidden><div class="period-presets" role="group" aria-label="Швидкий вибір"><span class="period-label">Швидкий вибір</span>${choices.map(([label,value,hint])=>`<button class="period-option period-preset" data-period="${value}" aria-pressed="${period===value}" ${validPeriod(value)?'':'disabled'}><span>${label}</span><small>${esc(hint)}</small>${periodIcon('check','period-check')}</button>`).join('')}</div><div id="period-calendar" class="period-calendar">${periodCalendar(year)}</div></div></div></div>`;
}
function closePeriodPicker(focus=false) {
 const popover=$('#period-popover');if(!popover||popover.hidden)return;
 popover.hidden=true;$('#period-trigger').setAttribute('aria-expanded','false');
 if(focus)$('#period-trigger').focus({preventScroll:true});
}
function togglePeriodPicker() {
 const popover=$('#period-popover');if(!popover.hidden){closePeriodPicker(true);return;}
 popover.hidden=false;$('#period-trigger').setAttribute('aria-expanded','true');
 (popover.querySelector('[aria-pressed=true]')??popover.querySelector('button:not(:disabled)'))?.focus({preventScroll:true});
}
async function selectPeriod(next) {
 if(!validPeriod(next))next='all';
 const token=++generation;$('#screen').setAttribute('aria-busy','true');$('#periods').classList.add('loading');
 try {
  let current=workspace,result=await api(`/api/period?period=${encodeURIComponent(next)}`);
  for(let attempt=0;result.revision!==current.revision&&attempt<2;attempt++){current=await api('/api/workspace');result=await api(`/api/period?period=${encodeURIComponent(next)}`);}
  if(result.revision!==current.revision)throw new Error('DATA_CHANGED');
  if(token!==generation)return;
  workspace=current;period=next;view=result;previous=result.comparison;
  if(token!==generation)return;
  render();
 }catch(error){failure(error);}finally{if(token===generation){$('#screen').removeAttribute('aria-busy');$('#periods').classList.remove('loading');}}
}
function periodEmpty(){return '<div class="empty-state"><h3>За цей період даних немає</h3><button class="link" data-action="allCollections">Весь період ↗</button></div>';}
function heading(title, action='') {return `<div class="head"><div><h1 tabindex="-1">${esc(title)}</h1></div>${action}</div>`;}
function line(label,amount,cls='',action='') {return `<${action?'button':'div'} class="line ${cls}" ${action?`data-action="${action}"`:''}><span>${esc(label)}</span><strong>${euro(amount)}</strong></${action?'button':'div'}>`;}
function stats(items) {return `<div class="strip">${items.map(([label,value,cls=''])=>`<div><span class="label">${esc(label)}</span><strong class="${cls}">${value}</strong></div>`).join('')}</div>`;}
function allRows() { return workspace.rows; }
function totals(c) {
 const value=workspace.collectionTotals[c.id]??{paid:0,recovered:0,net:0,count:0,bankNet:0,bankPaid:0,bankRecovered:0,estimatedCount:0,types:[],rowIds:[],otherPaid:0,deposits:0};
 return {...value,rows:allRows().filter(r=>value.rowIds.includes(r.id))};
}
const tripTypes={transport:'Транспорт',lodging:'Проживання',food:'Їжа й ресторани',shopping:'Покупки й подарунки',activities:'Активності',settlement:'Розрахунки з друзями',other:'Інше'};
const paymentDate=v=>v?.length===7?`${fullMonths[Number(v.slice(5))-1]} ${v.slice(0,4)}`:date(v);
const cashflowRow=r=>!r.excluded&&r.reportingScope!=='trip_only'&&r.reportingScope!=='purchase_only';
function tripDetails(c,editable=true) {
 const t=totals(c),own=t.rows.slice().sort((a,b)=>a.date.localeCompare(b.date));
 const action=r=>editable?`data-row="${esc(r.id)}"`:'';
 if(c.kind==='purchase')return `<section class="trip-detail"><p class="quiet purchase-valuation">Бюджетна EUR-оцінка: ${euro(t.bankNet,2)}. Основна сума — з операцій; ручні ціни залишаються в джерелах.</p><section class="flat-detail trip-payments-detail"><h3 class="flat-title">Оплати та повернення · ${own.length}</h3><ul class="split-breakdown">${own.map(r=>`<li><div><button class="link" ${action(r)}>${esc(r.description)}</button><small>${paymentDate(r.date)} · ${esc(prettyProvider(r.provider))}${r.splitParentId?' · частина переказу':''}</small></div><div><b>${purchaseRowMoney(r)}</b><small>${euro(r.eur,2)} у звіті</small></div></li>`).join('')}</ul></section></section>`;
 return `<section class="trip-detail"><div class="trip-summary">${stats([['Сплачено',euro(t.paid,2)],['Повернено',euro(t.recovered,2)],['Власним коштом',euro(t.net,2)]])}</div>${c.coverageNote?`<details class="coverage-note"><summary>Частина витрат</summary><p>${esc(c.coverageNote)}</p></details>`:''}<div class="trip-types">${t.types.map(x=>`<div><span>${esc(tripTypes[x.type])}</span><strong>${euro(x.eur,2)}</strong></div>`).join('')}</div><p class="quiet">За списаннями: ${euro(t.bankNet,2)}${t.estimatedCount?` · ${t.estimatedCount} оплат в історичній EUR-оцінці`:''}. ${c.kind==='trip'?'Головна сума — ціна покупок після повернень. Різниця з оцінкою списань не є окремою комісією.':''}</p>${t.otherPaid||t.deposits?`<div class="trip-context">${t.otherPaid?`<span>Сплачено іншими <b>${euro(t.otherPaid,2)}</b></span>`:''}${t.deposits?`<span>Депозити / блокування <b>${euro(t.deposits,2)}</b></span>`:''}<small>Поза власними витратами</small></div>`:''}<details class="trip-payments-detail" ${editable?'':'open'}><summary>Оплати та повернення · ${own.length}</summary><div class="table-wrap"><table class="data trip-payments"><thead><tr><th>Оплата</th><th>Тип</th><th>${c.kind==='purchase'?'EUR':'Ціна EUR'}</th>${c.kind==='purchase'?'':'<th>За списанням</th>'}</tr></thead><tbody>${own.map(r=>`<tr><td><button type="button" ${action(r)}>${esc(r.description)}</button><span class="subline display-block">${paymentDate(r.date)} · ${esc(prettyProvider(r.provider))}</span></td><td>${esc(tripTypes[r.spendingType??'other'])}</td><td class="${r.eur<0?'green':''}">${euro(c.kind==='trip'?r.purchaseValue.eur:r.eur,2)}${r.purchaseValue.estimated&&c.kind==='trip'?'<small class="subline display-block">історична оцінка</small>':''}</td>${c.kind==='purchase'?'':`<td>${euro(r.eur,2)}</td>`}</tr>`).join('')}</tbody></table></div></details></section>`;
}
function chart() {
 const points=capitalHistory.filter(p=>p.asOf<=selectedCapital().asOf&&inPeriod(p.asOf));
 if(points.length<2)return '';
 const values=points.map(p=>Number(p.bankMinor??p.knownMinor)),lo=Math.min(...values),hi=Math.max(...values),span=hi-lo||1;
 const xy=values.map((v,i)=>`${10+i/(values.length-1)*560},${148-(v-lo)/span*120}`);
 return `<svg class="chart" viewBox="0 0 580 165" role="img" aria-label="Історія рахунків і готівки у євро"><path d="M ${xy.join(' L ')}" fill="none" stroke="#087a65" stroke-width="2.5"/>${xy.map((p,i)=>`<circle cx="${p.split(',')[0]}" cy="${p.split(',')[1]}" r="3" fill="#087a65"><title>${date(points[i].asOf)}: ${euro(values[i])}</title></circle>`).join('')}</svg><div class="months"><span>${date(points[0].asOf)}</span><span>${date(points.at(-1).asOf)}</span></div>`;
}
function capitalGaps(c) {
 return {count:c.unvaluedCount+(c.cryptoUnpricedCount??0)};
}
const cryptoValued=c=>c.crypto.some(p=>p.eurMinor!==null);
const byValue=(a,b)=>(b.value??-Infinity)-(a.value??-Infinity);
function capitalHoldings(c) {
 const known=c.positions.filter(p=>p.reportMinor!==null);
 const bankTotal=known.reduce((total,p)=>total+BigInt(p.reportMinor),0n).toString();
 const providers=[...new Set(c.positions.map(p=>p.provider))].map(provider=>{
  const positions=c.positions.filter(p=>p.provider===provider),valued=positions.filter(p=>p.reportMinor!==null);
  return {crypto:false,key:provider,name:prettyProvider(provider),detail:!valued.length?'Немає оцінки':[...new Set(positions.map(p=>p.currency))].join(' · ')+(valued.length<positions.length?' · частина без оцінки':''),value:valued.length?valued.reduce((t,p)=>t+Number(p.reportMinor),0):null};
 }).sort(byValue);
 const wallets=c.crypto.map(p=>({crypto:true,name:p.chain==='near'?'NEAR':'Ethereum',detail:p.historical?.quantityBasis==='unknown'?'Кількість за період не підтверджена':`Крипто · ${p.historical?'ціна':'оцінка'} ${date(p.observedAt)}`,value:p.eurMinor===null?null:Number(p.eurMinor)})).sort(byValue);
 providers.forEach((item,n)=>item.tone=`k-a${Math.min(n,5)}`);wallets.forEach((item,n)=>item.tone=`k-c${Math.min(n,1)}`);
 const items=[...providers,...wallets],base=items.reduce((total,item)=>total+(item.value>0?item.value:0),0);
 const share=v=>base>0&&v>0?(v/base<0.01?'<1%':`${Math.round(v/base*100)}%`):'';
 let x=0;
 const bar=base>0?`<svg class="ov-alloc" viewBox="0 0 100 10" preserveAspectRatio="none" role="img" aria-label="Розподіл оціненого капіталу">${items.filter(item=>item.value>0).map(item=>{const w=item.value/base*100,rect=`<rect class="${item.tone}" x="${x.toFixed(3)}" width="${w.toFixed(3)}" height="10"><title>${esc(item.name)}: ${share(item.value)}</title></rect>`;x+=w;return rect;}).join('')}</svg>`:'';
 const row=item=>`<button class="ov-holding" ${item.crypto?'data-action="crypto"':`data-provider="${esc(item.key)}"`}><i class="ov-dot ${item.tone}" aria-hidden="true"></i><span class="ov-holding-name">${esc(item.name)}<small>${esc(item.detail)}</small></span><span class="ov-share">${share(item.value)}</span><strong>${euro(item.value)}</strong></button>`;
 return `<div class="ov-groups"><button data-action="accounts"><span>Рахунки й готівка ↗</span><strong data-account-total>${euro(known.length?bankTotal:null)}</strong></button><button data-action="crypto"><span>Крипто ↗</span><strong>${euro(cryptoValued(c)?c.cryptoMinor:null)}</strong></button></div>${bar}<div class="ov-holdings">${items.map(row).join('')}</div>${known.length<c.positions.length?'<p class="asset-missing">Частина рахунків без оцінки</p>':''}${!c.crypto.length?'<p class="asset-missing">Крипто: немає збереженої оцінки</p>':''}`;
}
function plotAxis(hi,lo){return hi===lo?`<span></span><span>${euro(hi)}</span><span></span>`:`<span>${euro(hi)}</span><span>${euro((hi+lo)/2)}</span><span>${euro(lo)}</span>`;}
function capitalTrend(c) {
 const points=capitalHistory.filter(p=>p.asOf<=c.asOf&&inPeriod(p.asOf));
 if(points.length<2)return '';
 const values=points.map(p=>Number(p.knownMinor)),lo=Math.min(...values),hi=Math.max(...values),span=hi-lo,step=100/(values.length-1);
 const x=i=>i*step,y=v=>span?100-(v-lo)/span*100:50,xy=values.map((v,i)=>`${x(i).toFixed(2)},${y(v).toFixed(2)}`);
 const hits=values.map((v,i)=>{const left=Math.max(0,x(i)-step/2),right=Math.min(100,x(i)+step/2);return `<rect class="ov-hit" x="${left.toFixed(2)}" y="0" width="${(right-left).toFixed(2)}" height="100"><title>${date(points[i].asOf)}: ${euro(v)}</title></rect>`;}).join('');
 return `<div class="ov-trend"><div class="ov-trend-head"><span>${points.some(p=>p.missingCount||p.cryptoUnpricedCount)?'Оцінена частина капіталу':'Капітал'} · історія</span><span>${date(points[0].asOf)} — ${date(points.at(-1).asOf)}</span></div><div class="ov-plot"><svg class="ov-line-chart" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Історія оціненого капіталу у євро"><defs><linearGradient id="ov-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="ov-stop-top"/><stop offset="1" class="ov-stop-bottom"/></linearGradient></defs><path class="ov-grid" d="M0,0H100M0,50H100M0,100H100"/><path class="ov-area" d="M0,100L${xy.join('L')}L100,100Z"/><path class="ov-line" d="M${xy.join('L')}"/><path class="ov-end" d="M${xy.at(-1)}l0,0"/>${hits}</svg><div class="ov-y" aria-hidden="true">${plotAxis(hi,lo)}</div></div></div>`;
}
function monthSpending(m){return allRows().filter(r=>cashflowRow(r)&&r.date.startsWith(m.month)).reduce((a,r)=>a+r.eur,0)-(m.grossSpending-m.netSpending);}
function monthlyTrend() {
 const data=view.months.filter(m=>!m.manualOnly).map(m=>({m,income:m.income,spend:monthSpending(m)}));
 if(data.length<2)return '';
 const max=Math.max(1,...data.map(d=>Math.max(d.income,d.spend,0))),slot=100/data.length,width=slot*.34,h=v=>Math.max(0,v)/max*100;
 const bars=data.map((d,i)=>{const x0=i*slot+slot*.14;return `<rect class="ov-bar-income" x="${x0.toFixed(3)}" y="${(100-h(d.income)).toFixed(3)}" width="${width.toFixed(3)}" height="${h(d.income).toFixed(3)}"/><rect class="ov-bar-spend" x="${(x0+width+slot*.04).toFixed(3)}" y="${(100-h(d.spend)).toFixed(3)}" width="${width.toFixed(3)}" height="${h(d.spend).toFixed(3)}"/><rect class="ov-hit" x="${(i*slot).toFixed(3)}" y="0" width="${slot.toFixed(3)}" height="100"><title>${fullMonths[Number(d.m.month.slice(5))-1]} ${d.m.month.slice(0,4)}: дохід ${euro(d.income)} · витрати ${euro(d.spend)} · податки й комісії ${euro(d.m.tax+d.m.bank)}</title></rect>`;}).join('');
 const label=(d,i)=>{const k=Number(d.m.month.slice(5))-1;return data.length<=12?monthNames[k]:i%3===0?`${monthNames[k]} ’${d.m.month.slice(2,4)}`:'';};
 return `<section class="ov-months"><div class="section-head"><h2>По місяцях</h2><div class="ov-legend"><span><i class="ov-dot ov-income" aria-hidden="true"></i>Дохід</span><span><i class="ov-dot ov-spend" aria-hidden="true"></i>Особисті витрати</span><button class="link" data-action="monthly">Таблиця ↗</button></div></div><div class="ov-plot ov-plot-bars"><svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Дохід і особисті витрати по місяцях"><path class="ov-grid" d="M0,0H100M0,50H100M0,100H100"/>${bars}</svg><div class="ov-y" aria-hidden="true">${plotAxis(max,0)}</div><div class="ov-x" aria-hidden="true">${data.map((d,i)=>`<span>${label(d,i)}</span>`).join('')}</div></div></section>`;
}
function flowBar() {
 if(view.manualOnly||!(view.income>0))return '';
 const rest=view.remainder-(view.fx??0);
 if(rest<0)return `<p class="ov-flow-note">Витрати, податки, комісії й FX перевищили дохід на ${euro(-rest)}</p>`;
 const parts=[['k-spend',view.net,'витрати'],['k-cost',view.tax+view.bank+(view.fx??0),'податки, комісії й FX'],['k-rest',rest,'залишок']];
 if(parts.some(([,v])=>v<0))return '';
 let x=0;
 return `<svg class="ov-flowbar" viewBox="0 0 100 10" preserveAspectRatio="none" role="img" aria-label="Розподіл доходу: ${parts.map(([,v,l])=>`${l} ${percent(v,view.income)}`).join(', ')}">${parts.map(([cls,v])=>{const w=v/view.income*100,rect=`<rect class="${cls}" x="${x.toFixed(3)}" width="${w.toFixed(3)}" height="10"/>`;x+=w;return rect;}).join('')}</svg>`;
}
function flowLine(label,amount,cls,action,dot='',sub='') {return `<button class="line ${cls}" data-action="${action}"><span class="ov-line-label">${dot?`<i class="ov-dot ${dot}" aria-hidden="true"></i>`:''}<span>${esc(label)}${sub?`<small>${sub}</small>`:''}</span></span><strong>${euro(amount)}</strong></button>`;}
function costsNote() {
 if(view.manualOnly||!(view.income>0))return '';
 const all=view.tax+view.bank+(view.fx??0);
 return view.fx===null?`${percent(all,view.income)} доходу · FX без оцінки`:`${percent(all,view.income)} доходу · з них FX ${euro(view.fx)} (${percent(view.fx,view.income)} доходу)`;
}
function spendComparison() {
 if(!Number.isSafeInteger(previous?.net)||!(previous.net>0))return '';
 const delta=view.net-previous.net,change=Math.abs(delta/previous.net*100).toLocaleString('uk-UA',{maximumFractionDigits:1});
 return `${budgetComparisonLabel()}: <b class="${delta>0?'red':delta<0?'green':''}">${signedEuro(delta)} · ${delta>0?'+':delta<0?'−':''}${change}%</b>`;
}
function budgetBar(c) {
 if(!c.plan)return '<span class="ov-nolimit">Без ліміту</span>';
 const actual=Math.max(0,c.actual),scale=Math.max(actual,c.plan),limit=c.plan/scale*100,over=actual>c.plan?(actual-c.plan)/scale*100:0;
 return `<span class="ov-budget-bar"><svg viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true"><rect class="ov-track" width="${limit.toFixed(3)}" height="8"/><rect class="ov-fill" width="${(Math.min(actual,c.plan)/scale*100).toFixed(3)}" height="8"/>${over?`<rect class="ov-over" x="${limit.toFixed(3)}" width="${over.toFixed(3)}" height="8"/><rect class="ov-limit" x="${(limit-.5).toFixed(3)}" width="1" height="8"/>`:''}</svg><span class="${over?'red':''}">${Math.round(c.actual/c.plan*100)}%</span></span>`;
}
function overviewBudget() {
 if(!view.months.length)return '';
 const categories=view.categories.filter(c=>c.actual||c.plan).sort((a,b)=>Number(b.plan>0&&b.actual>b.plan)-Number(a.plan>0&&a.actual>a.plan)||b.actual-a.actual),shown=categories.slice(0,6);
 const remaining=view.plan-view.net,rest=view.net-shown.reduce((n,c)=>n+c.actual,0);
 const difference=c=>!c.plan?'<span class="muted">—</span>':c.actual>c.plan?`<span class="red">+${euro(c.actual-c.plan)}</span><small>понад план</small>`:`<span class="green">${euro(c.plan-c.actual)}</span><small>залишок</small>`;
 return `<section class="ov-budget"><div class="section-head"><h2>Бюджет</h2><button class="link" data-page="budget">Повний бюджет ↗</button></div><div class="ov-budget-total"><span><b>${euro(view.net)}</b> із ${euro(view.plan)}</span><strong class="${remaining<0?'red':'green'}">${remaining<0?'Понад план':'Залишилось'} ${euro(Math.abs(remaining))}</strong></div>${view.plan>0?budgetBar({plan:view.plan,actual:view.net}):''}${shown.length?`<div class="table-wrap"><table class="data ov-budget-table"><thead><tr><th>Категорія</th><th>Використано ліміту</th><th>Витрачено</th><th>Ліміт</th><th>Різниця</th></tr></thead><tbody>${shown.map(c=>`<tr><td><button data-category="${esc(c.category)}">${esc(categoryName(c.category))}</button></td><td>${budgetBar(c)}</td><td>${euro(c.actual)}</td><td class="muted">${c.plan?euro(c.plan):'—'}</td><td>${difference(c)}</td></tr>`).join('')}</tbody></table></div>`:'<p class="quiet">Немає витрат і лімітів за цей період</p>'}${categories.length>shown.length||view.refunds?`<button class="link budget-more" data-page="budget">Інші категорії${view.refunds?' й повернення':''} · ${euro(rest)} ↗</button>`:''}</section>`;
}
function overview() {
 const c=selectedCapital(),gaps=capitalGaps(c),range=budgetPeriodRange(),flow=flowBar(),rest=view.remainder-(view.fx??0),costsAll=view.tax+view.bank+(view.fx??0),share=!view.manualOnly&&view.income>0?`${Math.round(rest/view.income*100)}% доходу`:'';
 const recent=allRows().filter(r=>r.reportingScope!=='trip_only'&&inPeriod(r.date)).sort((a,b)=>b.date.localeCompare(a.date)).slice(0,5);
 const dot=cls=>flow.startsWith('<svg')?cls:'';
 return heading('Огляд')+`<div class="dashboard-top"><section class="capital-overview"><div class="section-head"><h2>${c.asOf===view.currentCapital.asOf?'Поточний капітал':'Капітал на кінець періоду'}</h2><span class="quiet">на ${date(c.asOf)}</span></div><div class="capital-amount">${euro(c.positions.some(p=>p.reportMinor!==null)||cryptoValued(c)?c.knownNetMinor:null)}</div>${gaps.count?'<span class="capital-incomplete">Оцінена частина капіталу</span>':''}${capitalHoldings(c)}${BigInt(c.knownLiabilitiesMinor)>0n?`<p class="quiet">Враховано зобов’язання ${euro(c.knownLiabilitiesMinor)}</p>`:''}${capitalTrend(c)}</section><section class="period-flow"><div class="section-head"><h2>${esc(titlePeriod())}</h2><button class="link" data-action="monthly">Деталі ↗</button></div><p class="flow-coverage">${date(range.from)} — ${date(range.to)}${view.months.length&&view.partial?' · часткові дані':''}</p>${view.months.length?`${flow}<div class="month-lines">${flowLine('Дохід',view.manualOnly?null:view.income,'','monthly')}${flowLine('Особисті витрати',view.net,'','spending',dot('k-spend'),spendComparison())}${flowLine(view.fx===null?'Податки й комісії':'Податки, комісії й FX',view.manualOnly?null:costsAll,'','costs',dot('k-cost'),costsNote())}${flowLine('Залишок доходу',view.manualOnly?null:rest,'total-line '+(rest<0?'red':'green'),'monthly',dot('k-rest'),share)}${view.manualOnly?'':savingsLine()}</div>${view.manualOnly?'<p class="quiet">Лише ручні оплати</p>':''}`:periodEmpty()}</section></div>${monthlyTrend()}${overviewBudget()}<section class="recent-operations"><div class="section-head"><h2>Останні операції</h2><button class="link" data-page="transactions">Усі операції ↗</button></div>${recent.length?transactionTable(recent):'<p class="quiet">За цей період операцій немає</p>'}</section>`;
}

function cryptoPriceHistory() {
 const prices=workspace.report.cryptoHistory?.prices??[],months=[...new Set(prices.map(p=>p.month))].filter(m=>inPeriod(m+'-01')).sort();
 if(!months.length)return '';
 const value=(m,pair)=>prices.find(p=>p.month===m&&p.pair===pair)?.open;
 const number=n=>n==null?'—':Number(n).toLocaleString('uk-UA',{maximumFractionDigits:6});
 return `<details class="section"><summary>Місячні ціни NEAR · ${months.length}</summary><p class="quiet">Відкриття першого числа о 00:00 UTC. NEAR/EUR = NEAR/USDT ÷ EUR/USDT.</p><div class="table-wrap"><table class="data"><thead><tr><th>Дата</th><th>NEAR / USDT</th><th>EUR / USDT</th><th>NEAR / EUR</th></tr></thead><tbody>${months.map(m=>{const near=value(m,'NEARUSDT'),eur=value(m,'EURUSDT');return `<tr><td>${date(m+'-01')}</td><td data-private>${number(near)}</td><td data-private>${number(eur)}</td><td data-private>${number(near&&eur?Number(near)/Number(eur):null)}</td></tr>`;}).join('')}</tbody></table></div><p class="quiet"><a href="${esc(prices.find(p=>p.pair==='NEARUSDT')?.sourceUrl??prices[0].sourceUrl)}" target="_blank" rel="noopener noreferrer">Binance · збережені місячні ціни ↗</a></p></details>`;
}
function cryptoBox() {
 const c=selectedCapital();
 const cards=c.crypto.map(p=>{
  const h=p.historical;
  const detail=h?`<p class="quiet">Ціна на ${date(h.priceDate)}, 00:00 UTC · ${h.quantityBasis==='unknown'?'кількість за минулі місяці потребує підтвердження':'кількість незмінна за вашим підтвердженням'}. Володіння з ${paymentDate(h.holdingSince)}.</p><div class="table-wrap"><table class="data crypto-parts"><thead><tr><th>Актив</th><th>Кількість</th><th>Ціна USDT</th><th>EUR</th></tr></thead><tbody>${p.parts.map(part=>`<tr><td>${esc(part.label)}</td><td data-private>${esc(part.quantity??'—')}</td><td data-private>${esc(part.priceUsdt??'—')}</td><td>${euro(part.eurMinor,2)}</td></tr>`).join('')}</tbody></table></div><p class="quiet">${h.eurUsdt?`1 EUR = ${esc(h.eurUsdt)} USDT · Binance · ${date(h.priceDate)}`:'Курс EUR/USDT за цей місяць відсутній.'}${p.unpricedCount?' Частина активів без історичної оцінки.':''}</p>`:`<p class="quiet">${esc(p.account)} · ${usd(p.usdMinor)}</p><div class="table-wrap"><table class="data crypto-parts"><thead><tr><th>Актив / складова</th><th>Кількість</th><th>USD</th></tr></thead><tbody>${p.parts.map(part=>`<tr><td>${esc(part.label)}</td><td data-private>${esc(part.quantity??'—')}</td><td>${usd(part.usdMinor)}</td></tr>`).join('')}</tbody></table></div>${p.note?`<p class="quiet">${esc(p.note)}</p>`:''}<p class="quiet">${p.fx?`USD → EUR <span data-private>${esc(p.fx.rate)}</span> · ${esc(p.fx.source)} · ${date(p.fx.publicationDate)}${p.fx.stale?' · курс старший за 7 днів':''}`:'Немає USD → EUR курсу; позиція не включена у EUR-підсумок.'}</p>`;
  return `<article class="crypto-card"><div class="crypto-top"><h3>${p.chain==='near'?'NEAR':'Ethereum'}</h3><div class="crypto-value">${euro(p.eurMinor,2)}<span>${h?'Історична оцінка':usd(p.usdMinor)}</span></div></div><details class="crypto-details"><summary>Активи та оцінка</summary>${detail}</details><div class="crypto-footer"><span>${h?'Ціна на ':''}${date(p.observedAt)}</span><a href="${esc(h?.sources.find(s=>s.pair!=='EURUSDT')?.sourceUrl??p.sourceUrl)}" target="_blank" rel="noopener noreferrer">${h?'Binance':esc(p.source)} ↗</a></div></article>`;
 }).join('');
 return `<section class="section crypto-section"><div class="section-head"><h2>Крипто на ${date(c.asOf)}</h2><strong>${euro(cryptoValued(c)?c.cryptoMinor:null)}</strong></div>${c.crypto.some(p=>p.historical?.quantityBasis==='unknown')?'<p class="quiet">Період володіння збережено. Для історичної суми потрібно підтвердити кількість активів.</p>':''}${cards?`<div class="crypto-grid">${cards}</div>`:'<p class="quiet">За цей період немає збереженої оцінки крипто.</p>'}</section>${cryptoPriceHistory()}`;
}
function subscriptionTable(rows=view.rows) {
 const ai=rows.filter(r=>r.group==='AI-сервіси'||r.group==='Інші цифрові підписки');
 const groups=[...new Set(ai.map(r=>r.aiProvider??(r.group==='AI-сервіси'?'Інші AI':'Інші цифрові підписки')))];
 return `<div class="table-wrap"><table class="data subscriptions"><thead><tr><th>Сервіс</th><th>Оплат</th><th>За період</th><th>Середнє / міс.</th></tr></thead><tbody>${groups.map(g=>{const rows=ai.filter(r=>(r.aiProvider??(r.group==='AI-сервіси'?'Інші AI':'Інші цифрові підписки'))===g),amount=rows.reduce((a,r)=>a+r.eur,0);return `<tr><td>${esc(g)}</td><td>${rows.length}</td><td>${euro(amount,2)}</td><td>${euro(amount/view.months.length,2)}</td></tr>`;}).join('')}</tbody></table></div>`;
}
function budgetPeriodRange() { return view.availableRange??view.range; }

function budgetComparisonLabel(){return period==='all'?'Порівняння':period==='last12'?'До попередніх 12 місяців':period.length===4?'До минулого року':'До минулого місяця';}
const pencilIcon='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4z"/></svg>';
function budgetDifference(c) {
 if(!c.plan)return '<span class="muted">—</span>';
 return c.actual>c.plan?`<span class="red">+${euro(c.actual-c.plan)}</span><small>понад план</small>`:`<span class="green">${euro(c.plan-c.actual)}</span><small>залишок</small>`;
}
function budgetSummary(over,limited) {
 const range=budgetPeriodRange(),remaining=view.plan-view.net,change=period!=='all'&&Number.isSafeInteger(previous?.net)?view.net-previous.net:null;
 return `<section class="bg-summary"><div class="bg-summary-main"><span class="bg-kicker">Витрачено</span><div class="bg-total"><strong>${euro(view.net)}</strong><span>із ${euro(view.plan)}</span></div>${view.plan>0?budgetBar({plan:view.plan,actual:view.net}):''}<p class="bg-coverage">${date(range.from)} — ${date(range.to)}${view.months.some(m=>m.partial)?' · ліміти повних місяців':''}</p></div><div class="bg-summary-side"><div class="bg-fact"><span>${remaining<0?'Понад план':'Залишилось'}</span><strong class="${remaining<0?'red':'green'}">${euro(Math.abs(remaining))}</strong></div><div class="bg-fact"><span>Категорій понад ліміт</span><strong class="${over?'red':''}">${over} <small class="muted">з ${limited}</small></strong></div>${change!==null?`<div class="bg-fact"><span>${budgetComparisonLabel()}</span><strong class="${change>0?'red':change<0?'green':''}">${signedEuro(change)}${previous.net>0?`<small>${change>0?'+':''}${percent(change,previous.net)}</small>`:''}</strong></div>`:''}</div></section>`;
}
function budgetChanges() {
 if(period==='all'||!Number.isSafeInteger(previous?.net))return '';
 const delta=view.net-previous.net;
 const changes=[...new Set([...view.categories.map(c=>c.category),...previous.categories.map(c=>c.category)])].map(category=>{
  const current=view.categories.find(c=>c.category===category)?.actual??0,before=previous.categories.find(c=>c.category===category)?.actual??0;
  return {category,current,before,delta:current-before};
 }).filter(c=>c.delta!==0).sort((a,b)=>Math.abs(b.delta)-Math.abs(a.delta)).slice(0,5);
 if(!changes.length)return '';
 const max=Math.max(1,...changes.map(c=>Math.abs(c.delta))),remainder=delta-changes.reduce((sum,c)=>sum+c.delta,0);
 const bar=c=>{const w=Math.abs(c.delta)/max*50;return `<svg viewBox="0 0 100 8" preserveAspectRatio="none"><rect class="bg-track" width="100" height="8"/>${c.delta>0?`<rect class="bg-up" x="50" width="${w.toFixed(2)}" height="8"/>`:`<rect class="bg-down" x="${(50-w).toFixed(2)}" width="${w.toFixed(2)}" height="8"/>`}<rect class="bg-axis" x="49.6" width="0.8" height="8"/></svg>`;};
 return `<section class="bg-changes" aria-labelledby="bg-changes-title"><div class="section-head"><div><h2 id="bg-changes-title">${budgetComparisonLabel()}</h2><p class="bg-baseline">Було ${euro(previous.net)} · ${date(previous.from)}–${date(previous.to)} · найбільші зміни за категоріями</p></div><strong class="bg-change-total ${delta>0?'red':delta<0?'green':''}">${signedEuro(delta)}${previous.net>0?`<small>${delta>0?'+':''}${percent(delta,previous.net)}</small>`:''}</strong></div><div class="bg-change-list">${changes.map(c=>`<button class="bg-change" data-category="${esc(c.category)}"><span class="bg-change-name">${esc(categoryName(c.category))}<small>${euro(c.before)} → ${euro(c.current)}</small></span><span class="bg-diverge" aria-hidden="true">${bar(c)}</span><strong class="${c.delta>0?'red':'green'}">${signedEuro(c.delta)}</strong></button>`).join('')}</div>${remainder?`<div class="bg-change-rest"><span>Решта категорій</span><strong class="${remainder>0?'red':'green'}">${signedEuro(remainder)}</strong></div>`:''}</section>`;
}
function budget() {
 if(!view.months.length)return heading('Бюджет')+periodEmpty();
 const compare=period!=='all';
 const all=[...view.categories,...(previous?.categories??[]).filter(p=>!view.categories.some(c=>c.category===p.category)).map(p=>({category:p.category,actual:0,plan:0}))];
 const rows=all.filter(c=>budgetFilter!=='over'||c.plan>0&&c.actual>c.plan).sort((a,b)=>budgetSort==='name'?categoryName(a.category).localeCompare(categoryName(b.category),'uk'):budgetSort==='spent'?b.actual-a.actual:(b.actual-b.plan)-(a.actual-a.plan));
 const over=all.filter(c=>c.plan>0&&c.actual>c.plan).length,limited=all.filter(c=>c.plan>0).length;
 const amount=rows.reduce((n,c)=>n+c.actual,0)-(budgetFilter==='all'?view.refunds:0),plan=rows.reduce((n,c)=>n+c.plan,0);
 const columns=compare?7:6;
 const comparisonCell=c=>{
  if(!compare)return '';
  const before=previous?(previous.categories.find(p=>p.category===c.category)?.actual??0):null;
  if(before===null)return '<td class="bg-cmp">—</td>';
  const delta=c.actual-before;
  return `<td class="bg-cmp"><span class="${delta>0?'red':delta<0?'green':'muted'}">${delta===0?'без змін':signedEuro(delta)}</span><small>було ${euro(before)}</small></td>`;
 };
 const row=c=>`<tr class="${c.plan&&c.actual>c.plan?'is-over':''}"><td class="bg-name"><button data-category="${esc(c.category)}">${esc(categoryName(c.category))}</button></td><td class="bg-bar">${budgetBar(c)}</td><td class="bg-spent">${euro(c.actual)}</td><td class="bg-limit">${c.plan?euro(c.plan):'—'}</td><td class="bg-diff">${budgetDifference(c)}</td>${comparisonCell(c)}<td class="bg-edit"><button class="bg-edit-button" data-budget="${esc(c.category)}" aria-label="Змінити ліміт: ${esc(categoryName(c.category))}" title="Змінити ліміт">${pencilIcon}</button></td></tr>`;
 const refunds=budgetFilter==='all'&&view.refunds?`<tr class="bg-refund"><td class="bg-name">Повернення без категорії</td><td class="bg-bar"></td><td class="bg-spent green">${euro(-view.refunds)}</td><td class="bg-limit">—</td><td class="bg-diff"></td>${compare?'<td class="bg-cmp"></td>':''}<td class="bg-edit"></td></tr>`:'';
 const table=`<div class="table-wrap"><table class="data bg-table"><thead><tr><th>Категорія</th><th class="bg-bar">Використано ліміту</th><th>Витрачено</th><th>Ліміт</th><th>Різниця</th>${compare?`<th>${budgetComparisonLabel()}</th>`:''}<th><span class="sr">Дії</span></th></tr></thead><tbody>${rows.map(row).join('')}${!rows.length?`<tr><td colspan="${columns}"><div class="empty-state"><h3>Перевищень немає</h3></div></td></tr>`:''}${refunds}</tbody><tfoot><tr><th class="bg-name">${budgetFilter==='over'?'Разом у вибраних':'Разом'}</th><td class="bg-bar">${plan>0?budgetBar({plan,actual:amount}):''}</td><td class="bg-spent">${euro(amount)}</td><td class="bg-limit">${euro(plan)}</td><td class="bg-diff">${budgetDifference({plan,actual:amount})}</td>${compare?`<td class="bg-cmp">${budgetFilter==='all'&&previous?signedEuro(view.net-previous.net):'—'}</td>`:''}<td class="bg-edit"></td></tr></tfoot></table></div>`;
 const toolbar=`<div class="bg-toolbar"><h2>Категорії</h2><div class="bg-toolbar-controls"><div class="segmented" role="group" aria-label="Фільтр бюджету"><button class="chip ${budgetFilter==='all'?'on':''}" data-budget-filter="all" aria-pressed="${budgetFilter==='all'}">Усі <span>${all.length}</span></button><button class="chip ${budgetFilter==='over'?'on':''}" data-budget-filter="over" aria-pressed="${budgetFilter==='over'}">Понад ліміт <span>${over}</span></button></div><select class="select" id="budget-sort" aria-label="Сортування бюджету"><option value="overspend" ${budgetSort==='overspend'?'selected':''}>За перевищенням</option><option value="spent" ${budgetSort==='spent'?'selected':''}>За витратами</option><option value="name" ${budgetSort==='name'?'selected':''}>За назвою</option></select></div></div>`;
 return heading('Бюджет','<button class="link budget-settings" data-action="categories">Налаштування бюджету</button>')+budgetSummary(over,limited)+`<section class="bg-categories">${toolbar}${table}</section>`+budgetChanges();
}
function budgetValue(cat,month) { return workspace.state.budgets.filter(b=>b.category===cat&&b.from<=month).sort((a,b)=>b.from.localeCompare(a.from))[0]?.amount??(Object.hasOwn(workspace.report.plan,cat)?workspace.report.plan[cat]:0); }
function selectedCollections(kind) {
 const {from,to}=view.range;
 return workspace.state.collections.filter(c=>(kind==='purchase'?c.kind==='purchase':c.kind!=='purchase')&&(!seasonOnly||c.season)&&(collectionKind==='all'||c.kind===collectionKind||(kind==='purchase'&&purchaseLinkInfo(c).status===collectionKind))&&`${c.name} ${c.note} ${c.start} ${c.purchaseDetails?.category??''} ${(c.purchaseDetails?.items??[]).map(i=>`${i.name} ${i.sourceTitle} ${i.category} ${i.asin??''}`).join(' ')}`.toLocaleLowerCase('uk-UA').includes(collectionQuery.toLocaleLowerCase('uk-UA'))&&(period==='all'||allCollections||(c.datePrecision==='year'?c.start>=from&&c.end<=to:c.start<=to&&c.end>=from)||(c.kind!=='trip'&&totals(c).rows.some(r=>inPeriod(r.date))))).sort((a,b)=>kind==='purchase'?b.start.localeCompare(a.start):b.end.localeCompare(a.end)||b.start.localeCompare(a.start)||a.name.localeCompare(b.name,'uk-UA')||a.id.localeCompare(b.id));
}
const tripDates=c=>c.dateLabel??(date(c.start)+(c.end!==c.start?' — '+date(c.end):''));
function tripCard(c) {
 const t=totals(c),over=c.budget!==null&&t.net>c.budget;
 return `<button class="journey-card" data-collection="${esc(c.id)}"><span class="journey-card-content"><h3>${esc(c.name.split(' • ')[0])}</h3><span class="journey-date">${esc(tripDates(c))}${c.coverageNote?' · Частина витрат':''}</span></span><span class="journey-cost"><strong>${t.count?euro(t.net,2):'—'}</strong>${c.budget!==null?`<small class="${over?'red':''}">Бюджет ${euro(c.budget)} · ${over?'+':'залишок '}${euro(Math.abs(c.budget-t.net))}</small>`:''}</span></button>`;
}
function collectionToolbar(kind) {
 const options=kind==='purchase'?[['all','Усі покупки'],['matched','З транзакцією'],['unmatched','Без транзакції'],['cash','Сплачено готівкою'],['review','Потребує звірки'],['season','Святкові']]:[['all','Усі'],['trip','Поїздки'],['event','Події'],['season','Святкові']];
 return `<div class="collection-toolbar${kind==='trip'?' trip-toolbar':''}"><input class="search" id="collection-search" type="search" aria-label="Пошук записів" placeholder="Пошук…" value="${esc(collectionQuery)}"><select class="select" id="collection-filter" aria-label="Фільтр записів">${options.map(([v,l])=>`<option value="${v}" ${(seasonOnly?'season':collectionKind)===v?'selected':''}>${l}</option>`).join('')}</select>${kind==='trip'?'<button type="button" class="button" data-new="trip">+ Поїздка</button>':''}</div>`;
}
function collectionEmpty(kind) {
 const filtered=collectionQuery||seasonOnly||collectionKind!=='all';
 return `<div class="collection-empty"><h3>${filtered?'Нічого не знайдено':kind==='purchase'?'Покупок за цей період немає':'Поїздок за цей період немає'}</h3>${filtered?'<button class="link" data-action="resetCollectionFilters">Скинути</button>':''}</div>`;
}
function collectionSummary(selected,budgetCategory=null) {
 const total=selected.reduce((n,c)=>n+totals(c).net,0);
 if(budgetCategory){
  const budget=view.categories.find(c=>c.category===budgetCategory)?.plan;
  return `<section class="collection-summary"><div><span>Витрати</span><strong>${euro(total,2)}</strong></div><div><span>Бюджет категорії</span><strong><button type="button" data-budget="${esc(budgetCategory)}" aria-label="Бюджет категорії: ${esc(budgetCategory)}">${budget?euro(budget):'—'}</button></strong></div></section>`;
 }
 const planned=selected.filter(c=>c.budget!==null),budget=planned.reduce((n,c)=>n+c.budget,0),complete=planned.length===selected.length;
 return `<section class="collection-summary"><div><span>Власним коштом</span><strong>${euro(total,2)}</strong></div><div><span>Бюджет${planned.length&&!complete?' · '+planned.length+' із '+selected.length:''}</span><strong>${planned.length?euro(budget):'—'}</strong></div>${complete?`<div><span>${total>budget?'Понад бюджет':'Залишилось'}</span><strong class="${total>budget?'red':'green'}">${euro(Math.abs(budget-total))}</strong></div>`:''}</section>`;
}
function tripCollections() {
 const selected=selectedCollections('trip');
 const years=[...new Set(selected.map(c=>c.start.slice(0,4)))];
 const groups=years.map(year=>{
  const trips=selected.filter(c=>c.start.startsWith(year)),total=trips.reduce((sum,c)=>sum+totals(c).net,0);
  return `<section class="journey-year">${period==='all'||allCollections?`<div class="journey-year-heading"><h2>${year}</h2><div class="journey-year-total"><span>Разом за рік</span><strong data-private>${euro(total,2)}</strong></div></div>`:''}<div class="journey-grid">${trips.map(tripCard).join('')}</div></section>`;
 }).join('');
 return heading('Поїздки')+collectionToolbar('trip')+collectionSummary(selected,'Відпустки та подорожі')+(selected.length?groups:collectionEmpty('trip'));
}
function tripView(c,tab='overview') {
 const t=totals(c),over=c.budget!==null&&t.net>c.budget,positive=t.types.reduce((n,v)=>n+Math.max(0,v.eur),0);
 const categories=`<section class="journey-breakdown"><h3>Категорії</h3>${t.types.map(v=>`<div class="journey-type-row"><div><span>${esc(tripTypes[v.type])}</span><strong>${euro(v.eur,2)}</strong></div><meter min="0" max="${Math.max(1,positive)}" value="${Math.max(0,v.eur)}" aria-label="${esc(tripTypes[v.type])}"></meter></div>`).join('')||'<p class="quiet">Оплат немає</p>'}</section>`;
 const paymentLine=(label,amount,cls='')=>`<div class="line ${cls}"><span>${esc(label)}</span><strong>${euro(amount,2)}</strong></div>`;
 const overview=`<div class="journey-overview">${categories}<section class="journey-settlement"><h3>Оплати</h3>${paymentLine('Сплачено',t.paid)}${paymentLine('Повернуто',t.recovered,'green')}${t.otherPaid?paymentLine('Інші платники · поза витратами',t.otherPaid):''}${t.deposits?paymentLine('Депозити · поза витратами',t.deposits):''}<details class="journey-reconciliation"><summary>Банківська оцінка · ${euro(t.bankNet,2)}</summary><p>Ціна покупки в EUR; якщо її немає — історична оцінка.${t.estimatedCount?' Таких оплат: '+t.estimatedCount+'.':''} Різниця з банківською оцінкою не є окремою комісією.</p></details></section></div>${c.note?`<details class="journey-notes"><summary>Нотатки</summary><p>${esc(c.note)}</p></details>`:''}`;
 const payments=`<section class="journey-payments"><div class="journey-payments-head"><button class="chip" data-payment="${esc(c.id)}">+ Оплата</button></div>${tripDetails(c)}${paymentList(c)}</section>`;
 open(c.name,`<div class="journey-detail"><div class="journey-detail-top"><span class="journey-date">${esc(tripDates(c))}</span><button class="chip" data-trip-settings="${esc(c.id)}">Редагувати</button></div><section class="journey-hero"><div class="journey-own"><span>Власним коштом</span><strong>${t.count?euro(t.net,2):'—'}</strong></div><div class="journey-hero-budget"><span>Бюджет</span>${c.budget===null?`<button data-trip-settings="${esc(c.id)}" data-focus-budget>Додати</button>`:`<strong>${euro(c.budget,2)}</strong><small class="${over?'red':'green'}">${over?'Понад план':'Залишок'} ${euro(Math.abs(c.budget-t.net),2)}</small>`}</div></section>${c.coverageNote?`<details class="coverage-note"><summary>Частина витрат</summary><p>${esc(c.coverageNote)}</p></details>`:''}<div class="journey-detail-tabs" role="tablist" aria-label="Деталі поїздки">${[['overview','Огляд'],['payments','Оплати · '+t.count]].map(([value,label])=>`<button id="journey-tab-${value}" role="tab" aria-controls="journey-panel" aria-selected="${tab===value}" tabindex="${tab===value?0:-1}" data-trip-tab="${value}" data-trip-owner="${esc(c.id)}">${label}</button>`).join('')}</div><div id="journey-panel" role="tabpanel" aria-labelledby="journey-tab-${tab}">${tab==='payments'?payments:overview}</div></div>`);
 detailPage.dataset.layout='journey';
 if(tab==='payments')detailPage.querySelectorAll('.trip-payments-detail').forEach(d=>d.open=true);
}
function collections(kind) {
 if(kind==='trip'&&page==='events')return tripCollections();
 const selected=selectedCollections(kind);
 return heading('Покупки','<button class="button" data-new="purchase">+ Покупка</button>')+collectionToolbar('purchase')+(selected.length?`${selected.every(c=>c.purchaseDetails?.paidInCash)?'<p class="quiet">Сплачено готівкою · суми за джерелом</p>':collectionSummary(selected)}<div class="purchase-list">${selected.map(c=>{const t=totals(c);return `<button class="purchase-row" data-collection="${esc(c.id)}"><span class="purchase-copy"><strong>${esc(c.name)}</strong><span>${esc(tripDates(c))}${c.coverageNote?' · Частина витрат':''}${c.purchaseDetails?' · '+esc(c.purchaseDetails.category)+' · '+c.purchaseDetails.items.length+' поз.':''}</span>${purchaseLinkBadge(c)}</span><span class="purchase-value"><strong>${t.count?purchaseMoney(t,'net'):purchaseReference(c)!==null?euro(purchaseReference(c),2):'—'}</strong>${!t.count&&purchaseReference(c)!==null?'<small>За джерелом</small>':''}${t.recovered?`<small>Повернуто ${purchaseMoney(t,'recovered')}</small>`:c.budget!==null?`<small class="${t.net>c.budget?'red':''}">Бюджет ${euro(c.budget)}</small>`:''}</span><span class="purchase-arrow" aria-hidden="true">→</span></button>`;}).join('')}</div>`:collectionEmpty('purchase'));
}
function transactionRows(rows,editable=true) {return rows.map(r=>`<tr class="${r.excluded?'excluded-row':''}"><td>${paymentDate(r.date)}</td><td><button class="transaction-name" ${editable?`data-row="${esc(r.id)}"`:''}>${esc(r.description)}</button><div class="subline">${esc(r.provider)}${r.trip?' · '+esc(r.trip):''}${r.splitParentId?' · частина переказу':''}${r.excluded?' · поза витратами':''}${r.reportingScope==='purchase_only'?' · історична оплата, поза звітом':''}</div>${operationPurchaseLinks(r)}</td><td>${editable?`<button class="category-badge" data-row="${esc(r.id)}" aria-label="Редагувати: ${esc(r.description)}">${esc(rowCategoryLabel(r))}</button>`:esc(rowCategoryLabel(r))}</td><td class="${r.eur<0?'green':''}">${euro(r.eur,2)}${nativeAmount(r)&&r.currency!=='EUR'?`<span class="subline display-block native-amount">${esc(nativeAmount(r))}</span>`:''}</td></tr>`).join('');}
function transactionTable(rows) {return `<div class="table-wrap"><table class="data transactions"><thead><tr><th>Дата</th><th>Опис</th><th>Категорія</th><th>EUR</th></tr></thead><tbody>${transactionRows(rows)}</tbody></table></div>`;}
function transactions() {
 const rows=allRows().filter(r=>!r.splitParent&&r.reportingScope!=='trip_only'&&inPeriod(r.date)&&(!category||r.group===category)&&(transactionStatus==='all'||(transactionStatus==='expenses'?!r.excluded:transactionStatus==='review'?r.unresolved&&r.excluded&&rowOperationType(r)==='excluded':transactionStatus==='spending'?!r.excluded&&r.eur>=0:transactionStatus==='cash'?r.source==='manual_cash_expense':transactionStatus==='refunds'?!r.excluded&&r.eur<0:transactionStatus==='cash_fx'?rowOperationType(r)==='cash_fx':r.excluded))&&`${r.description} ${r.splitParentId?workspace.report.rows.find(p=>p.id===r.splitParentId)?.description??'':''} ${r.provider} ${r.date}`.toLocaleLowerCase('uk-UA').includes(query.toLocaleLowerCase('uk-UA'))).sort((a,b)=>b.date.localeCompare(a.date));
 const filtered=category||query||transactionStatus!=='all';
 const refunds=!category&&!query&&['all','expenses'].includes(transactionStatus)?view.refunds:0;
 const total=rows.filter(cashflowRow).reduce((n,r)=>n+r.eur,0)-refunds;
 return heading('Операції')+`<div class="toolbar transaction-toolbar"><label class="tx-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input class="search" id="search" type="search" placeholder="Назва, банк або дата…" aria-label="Пошук операцій" value="${esc(query)}"></label><select class="select" id="category-filter" aria-label="Категорія"><option value="">Усі категорії</option>${categoryOptions(category)}</select><select class="select" id="transaction-status" aria-label="Тип операцій">${[['all','Усі операції'],['expenses','Витрати й повернення'],['spending','Витрати'],['cash','Готівка'],['refunds','Повернення'],['cash_fx','Купівля валюти готівкою'],['excluded','Поза витратами'],['review','Без призначення']].map(([v,l])=>`<option value="${v}" ${v===transactionStatus?'selected':''}>${l}</option>`).join('')}</select>${filtered?'<button class="link" data-action="resetTransactions">Скинути</button>':''}</div><div class="results-line"><span>${rows.length} ${rows.length===1?'операція':rows.length%10>=2&&rows.length%10<=4&&(rows.length%100<12||rows.length%100>14)?'операції':'операцій'}</span><span class="transaction-total"><small>${['all','expenses'].includes(transactionStatus)?'Чисті витрати':'Сума вибірки'}</small><strong>${euro(total,2)}</strong></span></div>${refunds?`<div class="transaction-adjustment"><span>Повернення без категорії</span><strong class="green">${euro(-refunds,2)}</strong></div>`:''}${['AI-сервіси','Інші цифрові підписки'].includes(category)?`<section class="subscription-breakdown">${subscriptionTable(rows)}</section>`:''}${rows.length?transactionList(rows.slice(0,transactionLimit)):`<div class="empty-state"><h3>Операцій не знайдено</h3>${filtered?'<button class="chip" data-action="resetTransactions">Скинути фільтри</button>':''}</div>`}${rows.length>transactionLimit?`<button class="chip load-more" data-action="more">Ще · ${rows.length-transactionLimit} записів</button>`:''}`;
}
function cashMoney(value,currency){
 if(value===null||value===undefined)return '—';
 const minor=BigInt(value),absolute=minor<0n?-minor:minor;
 return `${minor<0n?'−':''}${new Intl.NumberFormat('uk-UA').format(absolute/100n)},${String(absolute%100n).padStart(2,'0')} ${esc(currency)}`;
}
function cashMonth(value){return `${fullMonths[Number(value.slice(5,7))-1]} ${value.slice(0,4)}`;}
function cash(){
 const positions=view.currentCapital.positions.filter(p=>p.type==='cash');
 const expenses=allRows().filter(r=>r.source==='manual_cash_expense'&&inPeriod(r.date)).sort((a,b)=>b.date.localeCompare(a.date));
 const observations=(workspace.cashHistory??[]).filter(r=>period==='all'||inPeriod(r.period));
 const currencies=[...new Set(observations.map(r=>r.currency))];
 const months=[...new Set(observations.map(r=>r.period))];
 const currencyPurchases=allRows().filter(r=>rowOperationType(r)==='cash_fx'&&inPeriod(r.date)).sort((a,b)=>b.date.localeCompare(a.date));
 const balances=positions.map(p=>{
  const evidence=p.manualEvidence,gap=evidence?.differenceMinor;
  return `<div class="cash-position"><span class="label">${esc(p.currency)}</span><strong class="cash-position-value ${p.status==='conflict'?'red':''}">${cashMoney(p.nativeMinor,p.currency)}</strong><span class="quiet">${p.precision==='month'?`Залишок за ${esc(cashMonth(p.observedAt))}`:p.observedAt?'Розраховано за відомими рухами':'Немає підтвердженого залишку'}</span>${p.status==='conflict'?'<p class="cash-warning">Потребує звірки</p>':''}${gap&&gap!=='0'?`<details class="cash-gap"><summary>Різниця з відомими рухами</summary><p>${cashMoney(gap,p.currency)}</p><p>Залишок у таблиці відрізняється від початкового балансу й записаних рухів. Ця різниця не створює витрат.</p></details>`:''}</div>`;
 }).join('');
 const history=months.map(month=>`<tr><td>${esc(cashMonth(month))}</td>${currencies.map(currency=>{
  const records=observations.filter(r=>r.period===month&&r.currency===currency);
  return `<td>${records.length?records.map(r=>`<div class="cash-observation"><strong class="${r.conflicting?'red':''}">${r.conflicting?'Суперечливі дані':cashMoney(r.amountMinor,currency)}</strong>${records.length>1?`<span class="subline">${esc(r.name)}</span>`:''}<span class="subline cash-source">${r.sources.map(s=>esc(`${s.sheet}!${s.address}`)).join(' · ')||'Джерело не вказано'}</span></div>`).join(''):'<span class="quiet">—</span>'}</td>`;
 }).join('')}</tr>`).join('');
 return heading('Готівка','<button class="button" data-action="newExpense">+ Витрата</button>')+`
 <section class="cash-balances"><div class="section-head"><h2>Облікована готівка</h2><span class="quiet">на ${date(view.currentCapital.asOf)}</span></div><div class="cash-positions">${balances||'<p class="quiet">Готівкових рахунків ще немає.</p>'}</div><p class="quiet cash-balance-note">Останній відомий залишок і внесені після нього рухи.</p></section>
 <section class="cash-expenses"><div class="section-head"><h2>Витрати готівкою</h2><span class="cash-expense-total">${euro(expenses.reduce((sum,r)=>sum+r.eur,0),2)}<small>Записів: ${expenses.length} · ${esc(titlePeriod())}</small></span></div>${expenses.length?transactionTable(expenses.slice(0,transactionLimit)):'<p class="empty">За цей період витрат готівкою немає.</p>'}${expenses.length>transactionLimit?`<button class="chip load-more" data-action="more">Ще · ${expenses.length-transactionLimit} записів</button>`:''}</section>
 <section class="cash-monthly"><div class="section-head"><h2>Помісячні залишки</h2><span class="quiet">Спостережень: ${observations.length}</span></div><p class="quiet">Залишки з таблиці за вибраний період. Місячна точність; пропуски не заповнюються.</p>${history?`<div class="table-wrap"><table class="data cash-history"><thead><tr><th>Місяць</th>${currencies.map(c=>`<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${history}</tbody></table></div>`:'<p class="empty">У цьому періоді немає помісячних залишків із таблиці.</p>'}</section>
 ${currencyPurchases.length?`<section class="cash-currency-purchases"><div class="section-head"><h2>Купівля валюти готівкою</h2></div><p class="quiet">Ці банківські платежі поза витратами. Отримана готівка потребує окремого підтвердження залишку.</p>${transactionTable(currencyPurchases)}</section>`:''}`;
}
function categoryKeys(){return [...new Set([...Object.keys(workspace.report.plan),...workspace.state.budgets.map(b=>b.category),...allRows().map(r=>r.group),...Object.values(workspace.state.overrides).map(r=>r.category)])].sort((a,b)=>categoryName(a).localeCompare(categoryName(b),'uk'));}
function categoryOptions(selected){return [...new Set([...categoryKeys(),...(selected?[selected]:[])])].map(c=>`<option ${c===selected?'selected':''} value="${esc(c)}">${esc(categoryName(c))}</option>`).join('');}
function categoriesEdit(){open('Налаштування бюджету',`<button class="chip" data-action="newBudget">+ Категорія</button><div class="category-list">${categoryKeys().map(c=>`<button class="category-item" data-rename-category="${esc(c)}"><span>${esc(categoryName(c))}</span><span aria-hidden="true">→</span></button>`).join('')}</div>`);}
function categoryEdit(cat){open('Категорія',`<form id="category-form" data-category="${esc(cat)}">${field('Назва категорії',`<input name="name" value="${esc(categoryName(cat))}" maxlength="240" required>`)}<div class="form-actions"><button class="button">Зберегти</button><button type="button" class="chip" data-action="close">Скасувати</button>${categoryName(cat)!==cat?'<button type="button" class="link" data-action="originalCategoryName">Початкова назва</button>':''}</div></form>`);}

function render() {
 renderPeriods();
 document.querySelectorAll('nav [data-page],#history').forEach(b=>b.disabled=false);
 document.querySelectorAll('[data-page]').forEach(b=>b.classList.toggle('active',b.dataset.page===page));
 renderNavigation();
 document.querySelectorAll('nav [data-page]').forEach(b=>b.setAttribute('aria-current',b.dataset.page===page?'page':'false'));
 $('#screen').innerHTML={overview,budget,cash,events:()=>collections('trip'),purchases:()=>collections('purchase'),transactions}[page]();
 const head=$('#screen .head, #screen .journey-head');$('#page-heading').replaceChildren(...(head?[head]:[]));
 if(!activePanel&&head?.children.length>1){const actions=document.createElement('div');actions.className='page-actions';actions.append(...[...head.children].slice(1));head.append(actions);}
 $('.topbar').hidden=!activePanel&&!(page==='transactions'&&category);
 amountPrivacy.refresh();
 navigation?.remember();
}
function formFingerprint(){const form=detailPage.querySelector('form');return form?JSON.stringify([...new FormData(form)])+JSON.stringify([...selectedRowIds].sort()):'';}
function open(title,html) {
 delete detailPage.dataset.layout;
 detailPage.innerHTML=`<header class="detail-heading"><h1 id="detail-title" tabindex="-1">${esc(title)}</h1></header>${html}<div id="discard-changes" hidden></div><p id="form-error" class="form-error" role="alert" hidden></p>`;
 $('#screen').hidden=true;$('#periods').hidden=true;$('#page-heading').hidden=true;detailPage.hidden=false;$('.topbar').hidden=false;
 formBaseline=formFingerprint();
 amountPrivacy.refresh();
}
function close(force=false){if(navigation?.canBack())navigation.back(force);else{clearDetail();activePanel=null;render();}}
function field(label,control){return `<label class="field"><span>${esc(label)}</span>${control}</label>`;}
let savingCash=false;
function cashExpenseEdit(id=null){
 const existing=workspace.state.cashExpenses?.find(e=>e.id===id);
 if(id&&!existing){open('Витрату видалено','<button class="chip" data-action="close">Назад</button>');return;}
 const accounts=workspace.cashAccounts??[];
 if(!accounts.length){open('Витрата готівкою','<p class="quiet">Готівкових рахунків ще немає.</p><button class="chip" data-action="close">Назад</button>');return;}
 const today=workspace.today??new Date().toISOString().slice(0,10),account=accounts.find(a=>a.id===existing?.accountId)??accounts.find(a=>a.currency==='EUR')??accounts[0];
 const selectedCategory=existing?.category??category;
 open(existing?'Витрата готівкою':'Нова витрата',`<form id="cash-expense-form" data-id="${esc(existing?.id??crypto.randomUUID())}" data-mode="${existing?'update':'create'}" autocomplete="off">
 <div class="cash-amount-line"><label class="cash-amount-field" for="cash-amount"><span>Сума</span><div><input id="cash-amount" data-private name="cashAmount" inputmode="decimal" type="text" placeholder="0,00" maxlength="16" value="${existing?(existing.amountMinor/100).toFixed(2).replace('.',','):''}" required aria-label="Сума витрати"><span id="cash-currency">${esc(account.currency)}</span></div></label></div>
 <div class="form-pair cash-main-fields">${field('Звідки',`<select name="cashAccount">${accounts.map(a=>`<option value="${esc(a.id)}" ${a.id===account.id?'selected':''}>${esc(a.name)}</option>`).join('')}</select>`)}${field('Дата',`<input name="cashDate" type="date" value="${existing?.date??today}" max="${today}" ${account.openingDate?`min="${account.openingDate}"`:''} required>`)}</div>
 ${field('Категорія',`<input name="cashCategory" list="cash-categories" value="${esc(selectedCategory?categoryName(selectedCategory):'')}" placeholder="Обери або введи свою" maxlength="240" required><datalist id="cash-categories">${categoryKeys().map(c=>`<option value="${esc(categoryName(c))}"></option>`).join('')}</datalist>`)}
 ${field('Опис · необов’язково',`<input name="cashDescription" value="${esc(existing?.description??'')}" placeholder="Наприклад, кава" maxlength="240">`)}
 <p class="cash-balance-hint quiet" id="cash-balance-hint"></p>
 <div class="form-actions cash-actions"><button class="button" type="submit">${existing?'Зберегти зміни':'Додати витрату'}</button><button class="chip" type="button" data-action="close">Скасувати</button>${existing?'<button class="link red" type="button" data-action="deleteExpense">Видалити</button>':''}</div></form>`);
 detailPage.dataset.layout='cash-expense';updateCashAccount();
}
function updateCashAccount(){
 const form=$('#cash-expense-form');if(!form)return;
 const account=workspace.cashAccounts.find(a=>a.id===form.elements.cashAccount.value);if(!account)return;
 $('#cash-currency').textContent=account.currency;
 if(account.openingDate)form.elements.cashDate.min=account.openingDate;else form.elements.cashDate.removeAttribute('min');
 const position=view.currentCapital.positions.find(p=>p.accountId===account.id),hint=$('#cash-balance-hint');
 hint.textContent=position?.nativeMinor!=null?`Облікований залишок: ${new Intl.NumberFormat('uk-UA',{minimumFractionDigits:2,maximumFractionDigits:2}).format(Number(position.nativeMinor)/100)} ${account.currency}${position.status==='conflict'?' · потребує звірки':''}`:'Залишок готівки ще не підтверджено';
}
async function saveCashExpense(form,data){
 if(savingCash)return;
 const amountMinor=toCents(String(data.get('cashAmount')).trim().replace(',','.'));
 if(!Number.isSafeInteger(amountMinor)||amountMinor<=0||amountMinor>1e12)throw new Error('AMOUNT_INVALID');
 const label=String(data.get('cashCategory')).trim(),key=categoryKeys().find(c=>categoryName(c).toLocaleLowerCase('uk')===label.toLocaleLowerCase('uk'))??label;
 await changeCashExpense({action:'cashExpense',mode:form.dataset.mode,expense:{id:form.dataset.id,accountId:data.get('cashAccount'),date:data.get('cashDate'),amountMinor,category:key,description:data.get('cashDescription')}},String(data.get('cashDate')).slice(0,7));
}
async function deleteCashExpense(){
 const form=$('#cash-expense-form');if(!form||savingCash)return;
 await changeCashExpense({action:'deleteCashExpense',id:form.dataset.id},form.elements.cashDate.value.slice(0,7));
}
async function changeCashExpense(change,month){
 savingCash=true;
 const controls=[...$('#cash-expense-form').querySelectorAll('button,input,select')];controls.forEach(el=>el.disabled=true);
 try{
  await api('/api/change',{...change,revision:workspace.revision});
  workspace=await api('/api/workspace');capitalHistory=await api('/api/capital-history');
  const target=workspace.report.months.some(m=>m.month===month)?month:workspace.report.months.at(-1).month;
  formBaseline=formFingerprint();
  await navigation.visit({...captureNavigation(),page:page==='cash'?'cash':'transactions',period:target,category:'',query:'',transactionStatus:'cash',panel:null,scroll:0,focus:null},true);
  notice(change.action==='deleteCashExpense'?'Витрату видалено':'Витрату збережено');
 }catch(error){
  // Keep the entered form intact; refresh only the revision after a conflicting write.
  if(error.message==='REVISION_CONFLICT')try{workspace=await api('/api/workspace');}catch{}
  formError(error);
 }finally{savingCash=false;controls.forEach(el=>el.disabled=false);}
}
function budgetEdit(cat='') {
 const from=period==='last12'?view.currentCapital.asOf.slice(0,7):period==='all'?workspace.report.months.at(-1).month:period.length===4?period+'-01':period;
 const firstYear=Math.min(Number(workspace.report.coverage.start.slice(0,4)),Number(from.slice(0,4))),lastYear=Math.max(Number(view.currentCapital.asOf.slice(0,4))+1,Number(from.slice(0,4)),...workspace.state.budgets.map(b=>Number(b.from.slice(0,4))));
 const years=Array.from({length:lastYear-firstYear+1},(_,i)=>String(firstYear+i));
 open('Ліміт бюджету',`<form id="budget-form" data-category="${esc(cat)}">${field('Категорія',cat?`<input name="category" value="${esc(categoryName(cat))}" readonly>`:'<input name="category" required maxlength="240">')}${field('Місячний ліміт, EUR',`<input data-private name="amount" type="number" min="0" max="10000000" step="0.01" value="${(budgetValue(cat,from)/100).toFixed(2)}" required>`)}<fieldset class="budget-start"><legend>Діє з</legend><div class="form-pair">${field('Рік',`<select name="fromYear" required>${years.map(y=>`<option value="${y}" ${y===from.slice(0,4)?'selected':''}>${y}</option>`).join('')}</select>`)}${field('Місяць',`<select name="fromMonth" required>${fullMonths.map((label,i)=>{const m=String(i+1).padStart(2,'0');return `<option value="${m}" ${m===from.slice(5,7)?'selected':''}>${label}</option>`;}).join('')}</select>`)}</div></fieldset><div class="form-actions"><button class="button">Зберегти</button><button type="button" class="chip" data-action="close">Скасувати</button></div></form>`);
}
function purchaseRowMoney(r){
 if(r.purchaseValue&&!r.purchaseValue.estimated)return euro(r.purchaseValue.eur,2);
 return r.nativeMinor&&r.currency?`<span data-private>${cashMoney(Math.abs(Number(r.nativeMinor))*(Math.sign(r.eur)||(r.splitParentId?1:0)),r.currency)}</span>`:`≈ ${euro(r.eur,2)}`;
}
function purchaseMoney(t,kind){
 if(t.purchaseAmounts?.estimatedCount===0)return euro(t.purchaseAmounts[kind],2);
 const native=t.nativeTotals?.length===1?t.nativeTotals[0]:null;
 if(native&&native.count===t.count)return `<span data-private>${cashMoney(native[kind+'Minor'],native.currency)}</span>`;
 return `≈ ${euro(t[kind],2)}`;
}
function canSplit(r){return ['ledger','zen_statement'].includes(r.source)&&r.eur>0&&!r.excluded&&r.nativeMinor&&r.currency&&Number(r.nativeMinor)<0&&!r.purchaseId&&!workspace.report.rows.some(x=>x.purchaseId===r.id)&&!workspace.state.collections.some(c=>c.rowIds.includes(r.id)||(c.payments??[]).some(p=>p.linkedRowId===r.id));}
function operationSplitView(r){
 const split=workspace.state.operationSplits[r.id],parts=allRows().filter(p=>p.splitParentId===r.id),confirmed=split.parts.filter(p=>p.kind==='expense').reduce((n,p)=>n+p.amountMinor,0);
 open(r.description,`<div class="op-summary"><div class="op-amount"><span>Оригінальне списання</span><strong data-private>${cashMoney(-Number(r.nativeMinor),split.currency)}</strong><small>${euro(r.eur,2)} у звіті · ${date(r.date)}</small></div></div><h2>Склад оплати</h2><ul class="split-breakdown">${parts.map(p=>`<li><div><strong>${esc(p.description)}</strong><small>${p.unresolved?'Нерозподілено · поза підтвердженими витратами':esc(categoryName(p.group))}</small>${operationPurchaseLinks(p)}</div><div><b data-private>${cashMoney(-Number(p.nativeMinor),split.currency)}</b><small>${euro(p.eur,2)} у звіті</small></div></li>`).join('')}</ul><p>Підтверджені витрати: <b data-private>${cashMoney(confirmed,split.currency)}</b></p><p class="quiet">EUR-оцінку списання розподілено пропорційно. Це не курс фактичної купівлі валюти. Повне списання повторно у витрати не входить.</p>${split.note?`<div class="flat-note"><p>${esc(split.note)}</p></div>`:''}${originalOperationDescription(r)}<div class="form-actions"><button class="button" data-split="${esc(r.id)}">Редагувати розподіл</button></div>`);
}
function splitPartFields(part,currency){
 return `<fieldset class="split-part" data-id="${esc(part.id)}"><legend>Частина оплати</legend>${field('Назва частини',`<input data-private name="splitName" value="${esc(part.name)}" maxlength="240" required>`)}<div class="form-pair">${field('Сума, '+esc(currency),`<input data-private name="splitAmount" type="number" min="0.01" step="0.01" max="10000000000" value="${part.amountMinor?(part.amountMinor/100).toFixed(2):''}" required>`)}${field('Облік',`<select name="splitKind"><option value="expense" ${part.kind==='expense'?'selected':''}>Підтверджена витрата</option><option value="unresolved" ${part.kind==='unresolved'?'selected':''}>Нерозподілено · поза витратами</option></select>`)}</div>${field('Категорія частини',`<select name="splitCategory">${categoryOptions(part.category)}</select>`)}${field('Покупка',`<select name="splitPurchase" ${part.kind==='unresolved'?'disabled':''}><option value="">Без прив’язки</option>${workspace.state.collections.filter(c=>c.kind==='purchase'&&!c.manualPayment).map(c=>`<option value="${esc(c.id)}" ${c.id===part.collectionId?'selected':''}>${esc(c.name)}</option>`).join('')}</select>`)}<button type="button" class="link red" data-action="removeSplitPart">Прибрати частину</button></fieldset>`;
}
function operationSplitEdit(id){
 const r=workspace.report.rows.find(r=>r.id===id);if(!r)return;
 const split=workspace.state.operationSplits?.[id]??{currency:r.currency,note:'',parts:[{id:crypto.randomUUID(),name:'',amountMinor:0,kind:'expense',category:r.homeGroup??r.group},{id:crypto.randomUUID(),name:'Нерозподілена частина',amountMinor:0,kind:'unresolved',category:r.homeGroup??r.group}]};
 open('Розподіл оплати',`<p>${esc(r.description)} · ${date(r.date)}</p><p>Оригінальне списання: <b data-private>${cashMoney(-Number(r.nativeMinor),split.currency)}</b></p><form id="operation-split-form" data-id="${esc(id)}" data-currency="${esc(split.currency)}" data-total="${-Number(r.nativeMinor)}"><div id="split-parts">${split.parts.map(p=>splitPartFields(p,split.currency)).join('')}</div><button type="button" class="chip" data-action="addSplitPart">+ Частина</button><p id="split-total" aria-live="polite"></p>${field('Нотатка про розподіл',`<textarea data-private name="splitNote" maxlength="2000" rows="3">${esc(split.note)}</textarea>`)}<p class="quiet">Нерозподілена частина не входить у підтверджені витрати й не змінює готівку чи борги. EUR-оцінка розподіляється пропорційно.</p><div class="form-actions"><button class="button">Зберегти розподіл</button><button type="button" class="chip" data-action="close">Скасувати</button>${workspace.state.operationSplits?.[id]?`<button type="button" class="link red" data-remove-split="${esc(id)}">Прибрати розподіл</button>`:''}</div></form>`);updateSplitTotal();
}
function updateSplitTotal(){
 const form=detailPage.querySelector('#operation-split-form');if(!form)return;
 let sum=0;try{for(const input of form.querySelectorAll('[name=splitAmount]'))sum+=input.value?toCents(input.value):0;}catch{form.querySelector('#split-total').textContent='Перевір суми частин.';return;}
 const remaining=Number(form.dataset.total)-sum;
 form.querySelector('#split-total').innerHTML=`Розподілено: <span data-private>${cashMoney(sum,form.dataset.currency)}</span> · ${remaining===0?'Сума збігається':`Різниця: <span data-private>${cashMoney(remaining,form.dataset.currency)}</span>`}`;
}
function purchaseLinkInfo(c){return workspace.purchaseLinkAudit?.links[c.id]??{status:'review',transactionCount:0,amountVerified:false,reason:'unavailable'};}
function purchaseLinkBadge(c,detail=false){
 const info=purchaseLinkInfo(c),labels={matched:info.amountVerified?'Транзакцію звірено':'З транзакцією',unmatched:'Без транзакції',cash:'Сплачено готівкою',review:'Потребує звірки'};
 const reasons={cash_confirmed:'Оплату готівкою підтверджено користувачем. Сума за джерелом; банківська транзакція не очікується.',no_transaction:'Банківську оплату ще не прив’язано.',missing_row:'Прив’язана транзакція відсутня у звіті.',shared_row:'Транзакція прив’язана до кількох покупок.',no_debit:'Прив’язані операції є поверненнями або поза витратами. Перевір склад оплат.',merchant_mismatch:'Початковий опис банку не підтверджує оплату Amazon.',unknown_order:'Amazon не підтверджує статус замовлення.',amount_unavailable:'Не вистачає початкової суми в EUR для звірки.',amount_mismatch:'Сума замовлення не збігається з початковою сумою оплати.',unavailable:'Статус зв’язку ще не завантажено.'};
 return `<span class="purchase-link-status is-${info.status}">${labels[info.status]}${info.transactionCount?' · '+info.transactionCount+' транз.':''}</span>${detail&&info.reason?`<p class="quiet">${reasons[info.reason]??''}</p>`:''}`;
}
function operationPurchaseLinks(r){
 const audit=workspace.purchaseLinkAudit;if(!audit)return '';
 const linked=(audit.rowLinks[r.id]??[]).map(id=>workspace.state.collections.find(c=>c.id===id)).filter(Boolean);
 if(linked.length)return `<div class="operation-purchase-links">${linked.map(c=>`<button class="link" data-collection="${esc(c.id)}">Покупка: ${esc(c.name)}</button>`).join('')}</div>`;
 return audit.unmatchedRetailerRows.includes(r.id)?'<span class="purchase-link-status is-unmatched">Без прив’язаної покупки</span>':'';
}
function originalOperationDescription(r){
 const original=workspace.report.rows.find(row=>row.id===(r.splitParentId??r.id))?.description;
 return original&&original!==r.description?`<div class="flat-note form-detail"><span class="flat-label">Оригінальний опис банку</span><p>${esc(original)}</p></div>`:'';
}
function purchaseReference(c){
 const orders=c.purchaseDetails?.sources.filter(s=>s.kind==='amazon'&&s.status!=='replacement')??[];
 if(orders.length){const values=orders.map(s=>s.amounts.find(a=>a.label==='Grand Total')?.eur);return values.every(Number.isSafeInteger)?values.reduce((n,v)=>n+v,0):null;}
 return c.referenceAmount??null;
}
function purchaseItems(c){
 const p=c.purchaseDetails;if(!p)return '';
 const amountLabels={'Item(s) Subtotal':'Товари','Postage & Packing':'Доставка','Total':'Разом','Grand Total':'До сплати','Promotion Applied':'Знижка','Gift Card Amount':'Подарунковий баланс','VAT':'ПДВ','Estimated VAT':'Розрахований ПДВ','Total Before VAT':'До ПДВ','Total before VAT':'До ПДВ','Reference':'У таблиці'};
 return `<section class="purchase-items"><h2>${esc(p.category)}</h2><p class="quiet">Ціни товарів наведені з джерела. Доставка, ПДВ та знижки можуть змінювати підсумок замовлення.</p><div class="table-wrap"><table class="data purchase-items-table"><thead><tr><th>Товар / послуга</th><th>Категорія</th><th>Кількість</th><th>Ціна у джерелі, EUR</th></tr></thead><tbody>${p.items.map(i=>`<tr><td><strong>${esc(i.name)}</strong><div class="item-source"><p>${esc(i.sourceTitle)}</p>${i.seller?`<p>Продавець: ${esc(i.seller)}</p>`:''}${i.asin?`<a href="https://www.amazon.de/dp/${encodeURIComponent(i.asin)}" target="_blank" rel="noreferrer">Amazon · ${esc(i.asin)}</a>`:''}</div></td><td>${esc(i.category)}${i.classification==='inferred'?'<small class="subline display-block">За описом товару</small>':''}</td><td>${i.quantity??'—'}</td><td>${i.displayedUnitPrice===null?'—':euro(i.displayedUnitPrice,2)}</td></tr>`).join('')}</tbody></table></div><section class="flat-detail purchase-sources"><h3 class="flat-title">Джерела та суми замовлень</h3>${p.sources.map(s=>`<section><h3>${esc(s.label)}${s.date?' · '+date(s.date):''}</h3>${s.status==='unknown'?'<p>Amazon не показує поточний статус цього замовлення.</p>':s.status==='replacement'?'<p>Безкоштовна заміна початкового товару.</p>':''}${s.orderId?`<a href="https://www.amazon.de/gp/your-account/order-details?orderID=${encodeURIComponent(s.orderId)}" target="_blank" rel="noreferrer">Замовлення ${esc(s.orderId)}</a>`:`<p>${esc(s.reference)}</p>`}${s.amounts.map(a=>`<div class="line"><span>${esc(amountLabels[a.label]??a.label)}</span><strong>${euro(a.eur,2)}</strong></div>`).join('')}</section>`).join('')}<p class="quiet">Суми джерел не додаються до витрат. Витрати визначають прив’язані оплати.</p></section></section>`;
}
function purchaseItemsEdit(c){
 const p=c.purchaseDetails;if(!p)return '';
 return `<section class="flat-detail form-detail purchase-items-edit"><h3 class="flat-title">Товари та категорії</h3>${field('Категорія покупки',`<input name="purchaseCategory" value="${esc(p.category)}" maxlength="240" required>`)}${p.items.map((i,n)=>`<fieldset data-purchase-item="${n}"><legend>Позиція ${n+1}</legend>${field('Назва товару / послуги',`<input name="itemName" value="${esc(i.name)}" maxlength="240" required>`)}${field('Категорія',`<input name="itemCategory" value="${esc(i.category)}" maxlength="240" required>`)}</fieldset>`).join('')}</section>`;
}
function purchaseItemsFromForm(form){
 const p=workspace.state.collections.find(c=>c.id===form.dataset.id)?.purchaseDetails;if(!p)return undefined;
 return {...p,category:form.querySelector('[name=purchaseCategory]').value,items:[...form.querySelectorAll('[data-purchase-item]')].map(row=>{const i=p.items[Number(row.dataset.purchaseItem)],name=row.querySelector('[name=itemName]').value,category=row.querySelector('[name=itemCategory]').value;return {...i,name,category,classification:name!==i.name||category!==i.category?'user':i.classification};})};
}
function transactionDayLabel(day){
 if(day.length===7)return `${fullMonths[Number(day.slice(5))-1]} ${day.slice(0,4)} · без точної дати`;
 const text=txDayFormat.format(new Date(`${day}T00:00:00Z`));
 return day.slice(0,4)===String(new Date().getFullYear())?text:`${text} ${day.slice(0,4)}`;
}
function transactionList(rows){
 const days=[];
 for(const r of rows){const key=r.date.slice(0,10),day=days.at(-1);if(day?.key===key)day.rows.push(r);else days.push({key,rows:[r]});}
 const row=r=>{
  const native=r.currency&&r.currency!=='EUR'?nativeAmount(r):'',links=operationPurchaseLinks(r);
  return `<li class="tx-row${cashflowRow(r)?'':' is-excluded'}"><button type="button" class="tx-main" data-row="${esc(r.id)}"><span class="tx-name">${esc(r.description)}</span><span class="tx-meta">${esc(prettyProvider(r.provider))}${r.trip?' · '+esc(r.trip):''}${r.splitParentId?' · частина переказу':''}${r.excluded?' · поза витратами':''}${r.reportingScope==='purchase_only'?' · історична оплата, поза звітом':''}</span></button>${links?`<div class="tx-links">${links}</div>`:''}<button type="button" class="tx-cat" data-row="${esc(r.id)}" aria-label="Змінити категорію: ${esc(r.description)}">${esc(rowCategoryLabel(r))}</button><span class="tx-amount${r.eur<0?' green':''}"><b>${euro(r.eur,2)}</b>${native?`<small>${esc(native)}</small>`:''}</span></li>`;
 };
 return `<div class="tx-list">${days.map(day=>`<section class="tx-day"><div class="tx-day-head"><span>${esc(transactionDayLabel(day.key))}</span><span>${day.rows.some(cashflowRow)?euro(day.rows.filter(cashflowRow).reduce((sum,r)=>sum+r.eur,0),2):''}</span></div><ul>${day.rows.map(row).join('')}</ul></section>`).join('')}</div>`;
}
const txDayFormat=new Intl.DateTimeFormat('uk-UA',{weekday:'short',day:'numeric',month:'long',timeZone:'UTC'});
function rowEdit(id) {
 if(id.startsWith('cash:')){cashExpenseEdit(id.slice(5));return;}
 if(id.startsWith('user:')){const r=allRows().find(r=>r.id===id),c=workspace.state.collections.find(c=>c.id===r?.collectionId),p=c?.payments?.find(p=>`user:${c.id}:${p.id}`===id);if(p)paymentEdit(c.id,p.id);else collectionEdit(r?.collectionId??id.slice(5),'purchase',true);return;}
 const r=allRows().find(r=>r.id===id),override=workspace.state.overrides[id];if(!r){const parent=id.startsWith('split:')&&workspace.report.rows.find(p=>id.startsWith(`split:${p.id}:`));if(parent)rowEdit(parent.id);return;}
 if(r.splitParentId){rowEdit(r.splitParentId);return;}
 if(r.splitParent){operationSplitView(r);return;}
 const type=rowOperationType(r),native=r.nativeMinor&&r.currency?`${new Intl.NumberFormat('uk-UA',{maximumFractionDigits:2}).format(Math.abs(Number(r.nativeMinor))/100)} ${r.currency}`:r.nativeEur!=null?euro(Math.abs(r.nativeEur),2):null;
 const label=r.eur<0?'Повернено':'Списано';
 const report=euro(Math.abs(r.eur),2),charged=native??report,day=r.date.length===10?transactionDayLabel(r.date):paymentDate(r.date);
 const types=Object.entries(operationLabels).filter(([key])=>key!=='cash_fx'||r.eur>0),checked=types.some(([key])=>key===type)?type:'expense';
 const fact=(name,value)=>`<div class="op-fact"><span>${name}</span><b>${esc(value)}</b></div>`;
 open(r.description||'Операція',`<div class="op-summary"><div class="op-amount${r.eur<0?' is-refund':''}"><span>${label}</span><strong>${esc(charged)}</strong>${native&&r.currency!=='EUR'&&r.nativeEur==null?`<small>${report} у звіті</small>`:!native?'<small>EUR-оцінка</small>':''}</div><div class="op-facts">${fact('Дата',day)}${fact('Рахунок',prettyProvider(r.provider))}${r.trip?fact('Поїздка',r.trip):''}</div></div>${operationPurchaseLinks(r)}${originalOperationDescription(r)}${canSplit(r)?`<button type="button" class="chip" data-split="${esc(id)}">Розподілити оплату</button>`:''}<form id="row-form" class="op-form" data-id="${esc(id)}">
 <fieldset class="op-types" aria-describedby="operation-effect"><legend>Тип операції</legend>${types.map(([key,text])=>`<label class="op-type"><input type="radio" name="operationType" value="${key}" ${key===checked?'checked':''}><span>${esc(text)}</span></label>`).join('')}</fieldset>
 <p id="operation-effect" class="operation-effect" aria-live="polite"></p>
 <div class="op-fields"><div id="operation-category">${field('Категорія',`<select name="category">${categoryOptions(override?.category??r.homeGroup??r.group)}</select>`)}</div>${field('Назва',`<input name="name" value="${esc(r.description)}" maxlength="4000" required>`)}</div>
 ${field('Нотатка',`<textarea name="note" rows="2" maxlength="2000" placeholder="Необов’язково">${esc(override?.name!==undefined?override.note:'')}</textarea>`)}
 <div class="form-actions"><button class="button">Зберегти</button><button type="button" class="chip" data-action="close">Скасувати</button></div></form>`);
 updateOperationForm();
}
function updateOperationForm(){
 const type=detailPage.querySelector('[name=operationType]:checked')?.value??'expense';
 $('#operation-category').hidden=type!=='expense';
 const effect=$('#operation-effect');
 effect.textContent=type==='cash_fx'?'Поза витратами · без зміни залишку готівки':type==='expense'?'':'Не входить у витрати';
 effect.hidden=!effect.textContent;
}

function purchaseView(c) {
 const t=totals(c);
 open(c.name,`<div class="purchase-detail"><div class="journey-detail-top"><span class="journey-date">${esc(tripDates(c))}</span><button class="chip" data-trip-settings="${esc(c.id)}">Редагувати</button></div>${t.count?`<div class="strip">${[['Витрати','net'],['Сплачено','paid'],['Повернуто','recovered']].map(([label,value])=>`<div><span class="label">${label}</span><strong>${purchaseMoney(t,value)}</strong></div>`).join('')}</div>`:c.purchaseDetails?.paidInCash?'<p class="quiet">Сплачено готівкою. Сума наведена за джерелом.</p>':'<p class="quiet">Оплати ще не прив’язані. Сума витрат не підтверджена.</p>'}${c.budget!==null?line('Бюджет',c.budget):''}${c.note?`<div class="flat-note journey-notes"><span class="flat-label">Нотатки</span><p>${esc(c.note)}</p></div>`:''}${purchaseLinkBadge(c,true)}${purchaseItems(c)}<section class="purchase-payments"><div class="section-head"><h2>Оплати</h2><button class="chip" data-payment="${esc(c.id)}">+ Оплата</button></div>${tripDetails(c)}${paymentList(c)}</section></div>`);
 detailPage.querySelector('.trip-payments-detail').open=true;
}
function collectionEdit(id,kind='trip',editing=false) {
 const c=workspace.state.collections.find(c=>c.id===id)??{id:crypto.randomUUID(),kind,name:'',start:view.capital.asOf,end:view.capital.asOf,budget:null,note:'',rowIds:[],season:false,referenceAmount:null};
 if(id&&!editing)return c.kind==='purchase'?purchaseView(c):tripView(c,activePanel?.tab??'overview');
 selectedRowIds=new Set(c.rowIds);
 open(c.name||'Новий запис',`<form id="collection-form" data-id="${esc(c.id)}" data-reference="${c.referenceAmount??''}">${field('Назва',`<input name="name" value="${esc(c.name)}" maxlength="240" required>`)}${field('Тип',`<select name="kind">${[['trip','Відпустка / подорож'],['event','Подія'],['purchase','Велика покупка']].map(([v,l])=>`<option value="${v}" ${v===c.kind?'selected':''}>${l}</option>`).join('')}</select>`)}<div class="form-pair">${field('Дата початку / покупки',`<input name="start" type="date" value="${c.start}" required>`)}${field('Дата завершення',`<input name="end" type="date" value="${c.end}" required>`)}</div>${field('Бюджет, EUR',`<input data-private name="budget" type="number" min="0" max="10000000" step="0.01" value="${c.budget===null?'':(c.budget/100).toFixed(2)}" placeholder="Ще не визначено">`)}<section class="flat-detail form-detail"><h3 class="flat-title">Додатково</h3>${field('Нотатка',`<textarea name="note" maxlength="2000">${esc(c.note)}</textarea>`)}<label class="checkline"><input name="season" type="checkbox" ${c.season?'checked':''}> Святковий сезон</label></section>${purchaseItemsEdit(c)}${c.referenceAmount!==null?`<p class="quiet">У ручній таблиці: ${euro(c.referenceAmount,2)}. Ця сума сама не створює витрат.</p>`:''}${c.manualPayment?`<section class="flat-detail"><h3 class="flat-title">Ручна оплата</h3><p class="quiet">Не дублюй оплату з виписки.</p>${field('Сплачено вручну, EUR',`<input data-private name="manualAmount" type="number" min="0.01" max="10000000" step="0.01" value="${c.manualPayment?(c.manualPayment.eur/100).toFixed(2):''}" placeholder="Без ручної оплати">`)}${field('Дата ручної оплати',`<input name="manualDate" type="date" value="${c.manualPayment?.date??c.start}">`)}</section>`:paymentList(c)}<section class="flat-detail trip-link-editor"><h3 class="flat-title">Прив’язані оплати</h3><input class="search full-width" id="link-search" type="search" aria-label="Пошук оплат для прив’язки" placeholder="Назва, банк або YYYY-MM"><div id="link-list"></div></section><div class="form-actions"><button class="button">Зберегти</button><button type="button" class="chip" data-action="close">Скасувати</button>${id?`<button type="button" class="link red" data-delete="${esc(id)}">Видалити</button>`:''}</div></form>`);renderLinks('');
}
function renderLinks(search) {
 const rows=allRows().filter(r=>r.source!=='user'&&!r.splitParent&&!r.splitParentId&&(selectedRowIds.has(r.id)||(search.trim()&&!r.excluded&&`${r.description} ${r.date} ${r.provider}`.toLocaleLowerCase('uk-UA').includes(search.toLocaleLowerCase('uk-UA'))))).sort((a,b)=>Number(selectedRowIds.has(b.id))-Number(selectedRowIds.has(a.id))||b.date.localeCompare(a.date));
 $('#link-list').innerHTML=`<p class="quiet">${selectedRowIds.size} оплат · ${euro(rows.filter(r=>selectedRowIds.has(r.id)).reduce((a,r)=>a+r.eur,0),2)}</p><div class="link-options">${rows.slice(0,Math.max(60,selectedRowIds.size+20)).map(r=>`<label class="link-option"><input type="checkbox" data-link-id="${esc(r.id)}" ${selectedRowIds.has(r.id)?'checked':''}><span>${esc(r.description)}<small>${date(r.date)} · ${esc(r.provider)}</small></span><b>${euro(r.eur,2)}</b></label>`).join('')}</div><p class="quiet">${rows.length>60?'Уточни пошук, щоб знайти інші оплати.':''}</p>`;
}
function showAccounts(provider) {
 const c=selectedCapital(), positions=c.positions.filter(p=>!provider||p.provider===provider);
 open(provider||'Рахунки',`<p class="quiet">на ${date(c.asOf)}</p>${provider?'':`<div class="account-history"><h2>Історія рахунків і готівки</h2>${chart()}</div>`}${positions.map(p=>`<details class="account-detail"><summary><span>${esc(p.name)}<small>${esc(p.provider)} · ${p.currency} · ${p.scope==='SOLE_PROPRIETOR'?'ФОП':'особистий'}</small></span><b>${euro(p.reportMinor,2)}</b></summary><div class="quiet"><p>Залишок: ${p.nativeMinor===null?'невідомий':esc(new Intl.NumberFormat('uk-UA',{maximumFractionDigits:2}).format(Number(p.nativeMinor)/100))+' '+esc(p.currency)} · дата ${p.precision==='month'?esc(p.observedAt):date(p.observedAt)}</p><p>${p.status==='known'?'Оцінено':p.status==='conflict'?'Суперечливі джерела':p.status==='missing_rate'?'Бракує курсу':'Бракує залишку'} · ${p.carriedForward?'перенесено з попередньої дати':'на дату звіту'}</p><p>Курс <span data-private>${esc(p.rate??'—')}</span> · ${esc(p.rateSource??'—')} · ${date(p.publicationDate)}${p.rateStale?' · старший за 7 днів':''}</p></div></details>`).join('')}`);
}
let savingsCache=null,savingsPending=null;
const afterFx=(remainder,fx)=>remainder===null||remainder===undefined?null:remainder-(fx??0);
function loadSavings() {
 const key=`${period}|${workspace.revision}`;
 if(savingsCache?.key===key)return Promise.resolve(savingsCache.value);
 if(savingsPending?.key===key)return savingsPending.promise;
 const promise=api(`/api/savings?period=${encodeURIComponent(period)}`).then(value=>{if(value.revision===workspace.revision)savingsCache={key,value};return value;}).finally(()=>{if(savingsPending?.key===key)savingsPending=null;});
 savingsPending={key,promise};
 return promise;
}
function savingsLine() {
 const key=`${period}|${workspace.revision}`,s=savingsCache?.key===key?savingsCache.value:null;
 if(!s){
  loadSavings().then(()=>{const slot=$('#ov-savings');if(slot)slot.outerHTML=savingsLine();}).catch(()=>{$('#ov-savings')?.remove();});
  return '<button class="line ov-savings" id="ov-savings" data-action="savings"><span class="ov-line-label"><span>Осіло на рахунках<small>Рахую за залишками рахунків…</small></span></span><strong class="muted">…</strong></button>';
 }
 const b=s.bridge,rest=b?afterFx(b.remainder,b.fx):null;if(!b||rest===null)return '';
 const gap=b.saved-rest;
 return `<button class="line ov-savings" id="ov-savings" data-action="savings"><span class="ov-line-label"><span>Осіло на рахунках<small>${gap===0?'як залишок доходу':`на ${euro(Math.abs(gap))} ${gap<0?'менше':'більше'} за залишок`}${b.unknownAccounts?' · неповні дані':''}</small></span></span><strong class="${b.saved<0?'red':''}">${euro(b.saved)}</strong></button>`;
}
async function showSavings() {
 const s=await loadSavings(),b=s.bridge;
 if(!b){open('Заощадження','<p class="quiet">За цей період даних немає.</p>');return;}
 const own=s.accounts.filter(a=>a.workspace),other=s.accounts.filter(a=>!a.workspace);
 const money=v=>v===null||v===undefined?'—':euro(v);
 const signed=v=>v===null||v===undefined?'—':signedEuro(Number(v));
 const step=(label,value,cls='',note='',plain=false)=>`<div class="sv-step ${cls}"><span>${label}${note?`<small>${note}</small>`:''}</span><strong>${plain?money(value):signed(value)}</strong></div>`;
 const otherNames=[...new Set(other.map(a=>prettyProvider(a.provider)))].join(', ')||'інших рахунках';
 const rest=afterFx(b.remainder,b.fx),gap=rest===null?null:b.saved-rest;
 const bridge=rest===null?'<p class="quiet">За цей період є лише ручні оплати, тож залишок доходу не розраховується.</p>':
  step('Залишок доходу',rest,'sv-base',`дохід − витрати − податки, комісії${b.fx===null?' (FX без оцінки)':' й FX'}`,true)
  +step(`${b.otherAccounts<0?'Знято з':'Лишилось на'} ${esc(otherNames)}`,-b.otherAccounts,'',`зміна їхніх залишків${b.unknownOtherAccounts?` · без залишку: ${b.unknownOtherAccounts}`:''}`)
  +step('Перекази без призначення',-b.unassigned,'','вийшли з рахунків, але не рахуються витратами')
  +step('Мало б осісти',b.expected,'sv-total','',true)
  +step('Фактично осіло',b.saved,'sv-total','Erste, Wise, Revolut, ZEN, готівка · без крипти',true)
  +step('Непояснено',b.unexplained,'sv-unexplained','готівка без записів, перекази на рахунки поза обліком чи на крипту, надходження в сусідньому місяці');
 const row=a=>`<tr><td>${esc(a.name)}<small>${esc(prettyProvider(a.provider))} · ${esc(a.currency)}${a.carriedForward?' · залишок перенесено з попередньої дати':''}</small></td><td>${money(a.startMinor)}</td><td>${money(a.endMinor)}</td><td class="${Number(a.savedMinor)<0?'red':Number(a.savedMinor)>0?'green':''}">${a.savedMinor===null?'<span class="muted">немає залишку</span>':signed(a.savedMinor)}</td><td class="muted">${a.revaluationMinor===null||a.revaluationMinor==='0'?'—':signed(a.revaluationMinor)}</td></tr>`;
 const head=`<thead><tr><th>Рахунок</th><th>${date(s.startAsOf)}</th><th>${date(s.endAsOf)}</th><th>Осіло</th><th>Переоцінка</th></tr></thead>`;
 const accounts=`<div class="table-wrap"><table class="data sv-accounts">${head}<tbody>${own.map(row).join('')}</tbody><tfoot><tr><th>Разом</th><td></td><td></td><td>${signed(b.saved)}</td><td class="muted">${b.revaluation?signed(b.revaluation):'—'}</td></tr></tfoot></table></div>`;
 const otherTable=other.length?`<details class="sv-other"><summary>${esc(otherNames)} · поза заощадженнями · зміна ${signed(b.otherAccounts)}</summary><div class="table-wrap"><table class="data sv-accounts">${head}<tbody>${other.map(row).join('')}</tbody></table></div></details>`:'';
 const months=s.months.length>1?`<section class="sv-months"><h2>По місяцях</h2><div class="table-wrap"><table class="data sv-month-table"><thead><tr><th>Місяць</th><th>Залишок доходу</th><th>Осіло</th><th>Різниця</th><th>Непояснено</th></tr></thead><tbody>${s.months.map(m=>{const r=afterFx(m.remainder,m.fx),d=r===null?null:m.saved-r;return `<tr><td>${monthNames[Number(m.month.slice(5))-1]} ${m.month.slice(0,4)}</td><td>${money(r)}</td><td>${money(m.saved)}</td><td class="${d===null?'':d<0?'red':'green'}">${signed(d)}</td><td class="muted">${signed(m.unexplained)}</td></tr>`;}).join('')}</tbody></table></div></section>`:'';
 open('Заощадження',`<p class="quiet">${date(s.from)} — ${date(s.to)} · залишки на ${date(s.startAsOf)} і ${date(s.endAsOf)}. «Осіло» — зміна рахунку без переоцінки валют.</p>${stats([['Залишок доходу',money(rest)],['Осіло на рахунках',money(b.saved)],['Різниця',signed(gap),gap===null?'':gap<0?'red':'green']])}<section class="sv-bridge"><h2>Звідки різниця</h2>${bridge}${b.revaluation?`<p class="quiet sv-note">Окремо: переоцінка валют ${signed(b.revaluation)}. Це зміна вартості USD у EUR, а не заощадження.</p>`:''}</section><section class="sv-accounts-section"><h2>Рахунки</h2>${accounts}${otherTable}</section>${months}`);
}
function showMonthly() {
 open('За місяцями',`<div class="table-wrap"><table class="data monthly-report"><thead><tr><th>Місяць</th><th>Зароблено</th><th>Витрати</th><th>Податки, комісії й FX</th><th>Залишок</th></tr></thead><tbody>${view.months.map(m=>{const current=monthSpending(m),costs=m.tax+m.bank+(m.fx??0);return `<tr><td>${m.month}</td><td data-label="Дохід">${euro(m.manualOnly?null:m.income)}</td><td data-label="Витрати">${euro(current)}</td><td data-label="Податки, комісії й FX">${euro(m.manualOnly?null:costs)}${m.fx===null&&!m.manualOnly?'<small class="subline display-block">FX без оцінки</small>':''}</td><td data-label="Залишок">${euro(m.manualOnly?null:m.income-current-costs)}</td></tr>`;}).join('')}</tbody></table></div>${view.unknown?`<p class="quiet">Нерозібрані перекази · ${euro(view.unknown)}</p>`:''}`);
}
function showCosts() {
 open('Податки й банк',stats([['Від доходу',percent(view.tax+view.bank,view.income)],['Сплачено',euro(view.tax+view.bank,2)]])+line('Податки',view.tax)+line('Банк',view.bank)+line(`FX · оцінка (${view.fx===null?'—':percent(view.fx,view.income)} доходу)`,view.fx)+`<div class="line total-line"><span>З FX · від доходу</span><strong>${view.fx===null?'—':percent(view.tax+view.bank+view.fx,view.income)}</strong></div><details class="inline-detail"><summary>Розрахунок</summary><p class="quiet">База: дохід ${euro(view.income,2)} · ${esc(titlePeriod())}. FX — оцінка відхилення від офіційного курсу, не окрема комісія.</p></details><div class="table-wrap"><table class="data cost-records"><thead><tr><th>Дата</th><th>Складова</th><th>EUR</th></tr></thead><tbody>${view.costRows.map(r=>`<tr><td>${date(r.date)}</td><td>${esc(r.label)}</td><td>${euro(r.eur,2)}</td></tr>`).join('')}</tbody></table></div>`);
}
async function showHistory() {
 const records=await api('/api/history');
 const labels={operationSplit:'Розподіл оплати',cashExpense:'Витрата готівкою',deleteCashExpense:'Видалення готівкової витрати',row:'Назва та категорія операції',categoryName:'Назва категорії',budget:'Ліміт бюджету',collection:'Подія або покупка',deleteCollection:'Видалення запису',undo:'Скасування правки',report_refresh:'Оновлення фінансового звіту',gift_category_split:'Подарунки — окрема категорія'};
 open('Історія правок',`<p class="quiet">Виписки ${date(workspace.statementCoverage.start)}–${date(workspace.statementCoverage.end)}</p>${records[0]&&!['undo','report_refresh'].includes(records[0].action)?'<button class="button outline" data-action="undo">Скасувати останню</button>':''}${records.map(r=>`<div class="line"><span>${esc(labels[r.action]??r.action)}<small class="subline display-block">${new Date(r.createdAt).toLocaleString('uk-UA')}</small></span><b>v${r.revision}</b></div>`).join('')||'<p class="empty">Правок немає</p>'}`);
}
function tripPrintReport() {
 const selected=selectedCollections('trip').sort((a,b)=>a.start.localeCompare(b.start));
 const title=allCollections?'Усі поїздки й події':titlePeriod();
 const sum=selected.reduce((n,c)=>n+totals(c).net,0);
 return `<div class="print-title">MoneyWave · ${esc(title)}</div><h1>Поїздки й події</h1>${stats([['Враховано власним коштом',euro(sum,2)],['Записів',selected.length],['Валюта','EUR']])}<p class="quiet">Ціна покупок після повернень. Банківський еквівалент показаний окремо для звірки. Оплати інших людей і депозити виключені з власної вартості.</p><table class="data trip-report-index"><thead><tr><th>Поїздка / подія</th><th>Власним коштом</th><th>За списаннями</th></tr></thead><tbody>${selected.map(c=>`<tr><td>${esc(c.name)}<small class="subline display-block">${esc(c.dateLabel??(date(c.start)+' — '+date(c.end)))}${c.coverageNote?' · частина витрат':''}</small></td><td>${euro(totals(c).net,2)}</td><td>${euro(totals(c).bankNet,2)}</td></tr>`).join('')}</tbody></table>${selected.map(c=>`<section class="print-trip"><h2>${esc(c.name)}</h2><p class="quiet">${esc(c.dateLabel??(date(c.start)+' — '+date(c.end)))}${c.budget!==null?' · бюджет '+euro(c.budget,2):''}</p>${tripDetails(c,false)}</section>`).join('')}<p class="quiet">MoneyWave · версія правок ${workspace.revision}. Історичні поїздки не розширюють покриття основного звіту про доходи й податки.</p>`;
}
function printReport() {
 const priorPage=page,priorAll=allCollections,priorSeason=seasonOnly,priorQuery=collectionQuery,priorKind=collectionKind,priorBudgetFilter=budgetFilter;allCollections=priorPage==='events'&&priorAll;seasonOnly=false;collectionQuery='';collectionKind='all';budgetFilter='all';$('#print-report').innerHTML=priorPage==='events'?tripPrintReport():`<div class="print-title">MoneyWave · ${esc(titlePeriod())}</div>${overview()}<div class="print-break"></div>${budget()}<div class="print-break"></div>${collections('trip')}${selectedCollections('trip').filter(c=>c.kind==='trip').sort((a,b)=>a.start.localeCompare(b.start)).map(c=>`<section class="print-trip"><h2>${esc(c.name)}</h2><p class="quiet">${esc(c.dateLabel??(date(c.start)+' — '+date(c.end)))}${c.budget!==null?' · бюджет '+euro(c.budget,2):''}</p>${tripDetails(c,false)}</section>`).join('')}<div class="print-break"></div>${collections('purchase')}<p class="quiet">Джерела: ${date(workspace.report.coverage.start)}–${date(workspace.report.coverage.end)} · поточна версія правок ${workspace.revision}. Всі суми EUR.</p>`;
 page=priorPage;allCollections=priorAll;seasonOnly=priorSeason;collectionQuery=priorQuery;collectionKind=priorKind;budgetFilter=priorBudgetFilter;
 $('#print-report').querySelectorAll('details').forEach(d=>d.open=true);
 $('#print-report').querySelectorAll('button,input,select').forEach(b=>b.disabled=true);
 $('#print-report').insertAdjacentHTML('afterbegin','<div class="print-actions"><button class="chip" id="print-back">← Назад до сайту</button><button class="button" id="print-save">Зберегти PDF / Друк</button></div>');
 document.body.classList.add('print-preview');window.scrollTo(0,0);
 $('#print-back').addEventListener('click',()=>close());
 $('#print-save').addEventListener('click',()=>window.print());
}
function paymentList(c) {
 const payments=c.payments??[];
 return `<section class="manual-payments">${payments.length?`<details><summary>Додаткові оплати · ${payments.length}</summary><div class="table-wrap"><table class="data"><tbody>${payments.map(p=>`<tr><td><button type="button" data-payment="${esc(c.id)}" data-payment-id="${esc(p.id)}">${esc(p.description)}</button><small class="subline display-block">${paymentDate(p.date)} · ${p.disposition==='deposit'?'депозит':p.payer==='other'?esc(p.payerName||'Інший платник'):p.linkedRowId?'пов’язано з випискою':'власна оплата'}</small></td><td>${euro(p.eur,2)}</td></tr>`).join('')}</tbody></table></div></details>`:''}${workspace.state.collections.some(x=>x.id===c.id)?`<button type="button" class="chip" data-payment="${esc(c.id)}">+ Оплата</button>`:''}</section>`;
}
function paymentEdit(collectionId,id) {
 const c=workspace.state.collections.find(x=>x.id===collectionId);if(!c)return;
 const existing=c.payments?.find(p=>p.id===id);
 const p=existing??{id:crypto.randomUUID(),date:c.start.slice(0,7),description:'',eur:0};
 const options=allRows().filter(r=>c.rowIds.includes(r.id));
 open(existing?'Редагувати оплату':'Додати оплату',`<form id="payment-form" data-collection="${esc(c.id)}" data-id="${esc(p.id)}">${field('Назва',`<input name="paymentName" value="${esc(p.description)}" maxlength="4000" required>`)}<div class="form-pair">${field('Тип запису',`<select name="paymentKind"><option value="expense" ${p.eur>=0&&p.disposition!=='deposit'?'selected':''}>Оплата</option><option value="refund" ${p.eur<0?'selected':''}>Повернення</option><option value="deposit" ${p.disposition==='deposit'?'selected':''}>Депозит / блокування</option></select>`)}${field('Сума, EUR',`<input data-private name="paymentAmount" type="number" min="0.01" max="10000000" step="0.01" value="${p.eur?Math.abs(p.eur/100).toFixed(2):''}" required>`)}</div><div class="form-pair">${field('Точність дати',`<select name="paymentPrecision"><option value="month" ${p.date.length===7?'selected':''}>Відомий місяць</option><option value="date" ${p.date.length===10?'selected':''}>Точна дата</option></select>`)}${field('Коли оплачено',`<input name="paymentDate" type="${p.date.length===7?'month':'date'}" value="${esc(p.date)}" data-original="${esc(p.date)}" required>`)}</div><div class="form-pair">${field('Хто сплатив',`<select name="paymentPayer"><option value="self" ${p.payer!=='other'?'selected':''}>Я</option><option value="other" ${p.payer==='other'?'selected':''}>Інша людина</option></select>`)}${field('Ім’я іншого платника',`<input name="paymentPayerName" value="${esc(p.payerName??'')}" maxlength="120">`)}</div>${field('Категорія',`<select name="paymentType">${Object.entries(tripTypes).map(([key,name])=>`<option value="${key}" ${(p.spendingType??'other')===key?'selected':''}>${name}</option>`).join('')}</select>`)}${field('Оплата у виписці',`<select name="paymentLink" ${p.linkedRowId?'disabled':''}><option value="">Окрема оплата</option>${options.map(r=>`<option value="${esc(r.id)}" ${r.id===p.linkedRowId?'selected':''}>${date(r.date)} · ${esc(r.description)} · ${euro(r.eur,2)}</option>`).join('')}</select>`)}<p class="quiet">Інші платники та депозити — поза витратами.</p>${p.sourceRefs?.length?`<details><summary>Джерело</summary><p class="quiet">${esc(p.sourceRefs.map(r=>`${r.artifactAlias??r.source??'Таблиця'} · рядок ${r.row??'—'}`).join('; '))}</p></details>`:''}<div class="form-actions"><button class="button">Зберегти</button><button type="button" class="chip" data-action="close">Скасувати</button>${existing?`<button type="button" class="link red" data-remove-payment="${esc(p.id)}" data-payment-owner="${esc(c.id)}">Видалити</button>`:''}</div></form>`);
}
function toCents(value){ const s=String(value);if(!/^\d+(?:\.\d{1,2})?$/.test(s))throw new Error('AMOUNT_INVALID');const [a,b='']=s.split('.');return Number(a)*100+Number(b.padEnd(2,'0')); }
document.addEventListener('click',async event=>{
 if(!event.target.closest('.period-control'))closePeriodPicker();
 const b=event.target.closest('button');if(!b||b.disabled)return;
 if(b.dataset.tripSettings){await showPanel({type:'collectionSettings',id:b.dataset.tripSettings});if(b.hasAttribute('data-focus-budget'))detailPage.querySelector('[name=budget]')?.focus();return;}
 if(b.dataset.tripTab){await showPanel({type:'collection',id:b.dataset.tripOwner,tab:b.dataset.tripTab});detailPage.querySelector(`[data-trip-tab="${b.dataset.tripTab}"]`)?.focus({preventScroll:true});return;}
 if(b.dataset.removePayment){const c=workspace.state.collections.find(x=>x.id===b.dataset.paymentOwner);if(c)await mutate({action:'collection',collection:{...c,payments:(c.payments??[]).filter(p=>p.id!==b.dataset.removePayment)}});return;}
 if(b.dataset.page){if(b.dataset.page!==page||activePanel)await navigate({page:b.dataset.page,query:'',category:'',collectionQuery:'',collectionKind:'all',transactionStatus:'all',allCollections:false,seasonOnly:false,transactionLimit:80});return;}
 if(b.dataset.calendarYear){const label=b.getAttribute('aria-label');$('#period-calendar').innerHTML=periodCalendar(b.dataset.calendarYear);const same=$('#period-calendar').querySelector(`[aria-label="${label}"]`);(same&&!same.disabled?same:$('#period-calendar .period-year-option')).focus({preventScroll:true});return;}
 if(b.dataset.period){closePeriodPicker(true);if(b.dataset.period!==period||allCollections||activePanel)await navigate({period:b.dataset.period,allCollections:false,scroll:window.scrollY,focus:b.id===''?'#period-trigger':'#'+CSS.escape(b.id)});return;}
 if(b.dataset.budgetFilter){budgetFilter=b.dataset.budgetFilter;render();document.querySelector(`[data-budget-filter="${budgetFilter}"]`)?.focus({preventScroll:true});return;}
 if(b.dataset.category){await navigate({page:'transactions',category:b.dataset.category,query:'',transactionStatus:'expenses',transactionLimit:80});return;}
 if(b.dataset.renameCategory){showPanel({type:'categoryName',category:b.dataset.renameCategory});return;}
 if(b.dataset.budget){showPanel({type:'budget',category:b.dataset.budget});return;}
 if(b.dataset.split){showPanel({type:'operationSplit',id:b.dataset.split});return;}
 if(b.dataset.action==='addSplitPart'){detailPage.querySelector('#split-parts').insertAdjacentHTML('beforeend',splitPartFields({id:crypto.randomUUID(),name:'',amountMinor:0,kind:'expense',category:categoryKeys()[0]},detailPage.querySelector('form').dataset.currency));updateSplitTotal();return;}
 if(b.dataset.action==='removeSplitPart'){b.closest('.split-part').remove();updateSplitTotal();return;}
 if(b.dataset.removeSplit){await mutate({action:'operationSplit',id:b.dataset.removeSplit,split:null});return;}
 if(b.dataset.row){showPanel({type:'row',id:b.dataset.row});return;}
 if(b.dataset.payment){showPanel({type:'payment',collectionId:b.dataset.payment,id:b.dataset.paymentId??null});return;}
 if(b.dataset.collection){showPanel({type:'collection',id:b.dataset.collection});return;}
 if(b.dataset.new){showPanel({type:'collection',kind:b.dataset.new});return;}
 if(b.dataset.provider){showPanel({type:'accounts',provider:b.dataset.provider});return;}
 if(b.dataset.delete){await mutate({action:'deleteCollection',id:b.dataset.delete});return;}
 const actions={newExpense:()=>showPanel({type:'cashExpense',id:null}),deleteExpense:()=>deleteCashExpense(),back:goBack,forward:()=>navigation.forward(),categories:()=>showPanel({type:'categories'}),originalCategoryName:()=>{detailPage.querySelector('[name=name]').value=detailPage.querySelector('form').dataset.category;},close:()=>close(),discard:()=>{const resume=pendingLeave;pendingLeave=null;if(resume)resume();else close(true);},keepEditing:()=>{pendingLeave=null;$('#discard-changes').hidden=true;detailPage.querySelector('input,select')?.focus();},resetTransactions:()=>{category='';query='';transactionStatus='all';render();$('#search').focus();},resetCollectionFilters:()=>{collectionQuery='';seasonOnly=false;collectionKind='all';render();},accounts:()=>showPanel({type:'accounts'}),monthly:()=>showPanel({type:'monthly'}),costs:()=>showPanel({type:'costs'}),savings:()=>showPanel({type:'savings'}),spending:()=>navigate({page:'transactions',category:'',query:'',transactionStatus:'expenses',transactionLimit:80}),reviewTransfers:()=>navigate({page:'transactions',category:'',query:'',transactionStatus:'review',transactionLimit:80}),budgetOver:()=>navigate({page:'budget',budgetFilter:'over'}),crypto:()=>showPanel({type:'crypto'}),periodPicker:togglePeriodPicker,newBudget:()=>showPanel({type:'budget'}),allCollections:()=>navigate({period:'all',allCollections:false}),more:()=>{transactionLimit+=80;render();},undo:()=>mutate({action:'undo'})};
 if(actions[b.dataset.action])await actions[b.dataset.action]();
});
document.addEventListener('keydown',event=>{
 if(event.key==='Escape'&&$('#period-popover')&&!$('#period-popover').hidden){event.preventDefault();closePeriodPicker(true);return;}
 if(!event.target.matches('[data-trip-tab]')||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
 const tabs=[...detailPage.querySelectorAll('[data-trip-tab]')],current=tabs.indexOf(event.target),next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(current+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
 event.preventDefault();tabs[next]?.click();
});
document.addEventListener('focusin',event=>{if(!event.target.closest('.period-control'))closePeriodPicker();});
document.addEventListener('input',event=>{
 if(event.target.id==='search'){const caret=event.target.selectionStart;query=event.target.value;transactionLimit=80;render();$('#search').focus();$('#search').setSelectionRange(caret,caret);navigation.remember();}
 if(event.target.closest('#operation-split-form'))updateSplitTotal();
 if(event.target.id==='link-search')renderLinks(event.target.value);
 if(event.target.id==='collection-search'){const caret=event.target.selectionStart;collectionQuery=event.target.value;render();$('#collection-search').focus();$('#collection-search').setSelectionRange(caret,caret);navigation.remember();}
});
document.addEventListener('change',async event=>{
 if(event.target.name==='cashAccount'){updateCashAccount();return;}
 if(event.target.name==='splitKind'){const part=event.target.closest('.split-part'),select=part.querySelector('[name=splitPurchase]');if(event.target.value==='unresolved')select.value='';select.disabled=event.target.value==='unresolved';updateSplitTotal();return;}
 if(event.target.name==='operationType'){updateOperationForm();return;}
 if(event.target.id==='collection-filter'){seasonOnly=event.target.value==='season';collectionKind=seasonOnly?'all':event.target.value;render();$('#collection-filter').focus();return;}
 if(event.target.name==='paymentPrecision'){const input=detailPage.querySelector('[name=paymentDate]');input.type=event.target.value;input.value=event.target.value==='month'?input.dataset.original.slice(0,7):(input.dataset.original.length===10?input.dataset.original:'');return;}
 if(event.target.id==='budget-sort'){budgetSort=event.target.value;render();$('#budget-sort').focus();}
 if(event.target.id==='transaction-status'){transactionStatus=event.target.value;transactionLimit=80;render();$('#transaction-status').focus();}
 if(event.target.id==='category-filter'){category=event.target.value;transactionLimit=80;render();$('#category-filter').focus();}
 if(event.target.dataset.linkId){if(event.target.checked)selectedRowIds.add(event.target.dataset.linkId);else selectedRowIds.delete(event.target.dataset.linkId);renderLinks($('#link-search').value);}
});
document.addEventListener('submit',async event=>{
 event.preventDefault();const form=event.target,data=new FormData(form);
 try{
 if(form.id==='operation-split-form'){const parts=[...form.querySelectorAll('.split-part')].map(p=>({id:p.dataset.id,name:p.querySelector('[name=splitName]').value,amountMinor:toCents(p.querySelector('[name=splitAmount]').value),kind:p.querySelector('[name=splitKind]').value,category:p.querySelector('[name=splitCategory]').value,collectionId:p.querySelector('[name=splitPurchase]').value||undefined}));await mutate({action:'operationSplit',id:form.dataset.id,split:{currency:form.dataset.currency,note:data.get('splitNote'),parts}});return;}
 if(form.id==='cash-expense-form'){await saveCashExpense(form,data);return;}
 if(form.id==='payment-form'){
  const c=workspace.state.collections.find(x=>x.id===form.dataset.collection),old=c.payments?.find(p=>p.id===form.dataset.id);
  const payment={...old,id:form.dataset.id,description:data.get('paymentName'),date:data.get('paymentDate'),eur:toCents(data.get('paymentAmount'))*(data.get('paymentKind')==='refund'?-1:1),payer:data.get('paymentPayer'),payerName:data.get('paymentPayerName'),disposition:data.get('paymentKind')==='deposit'?'deposit':'expense',spendingType:data.get('paymentType'),linkedRowId:old?.linkedRowId||data.get('paymentLink')||undefined};
  await mutate({action:'collection',collection:{...c,payments:[...(c.payments??[]).filter(p=>p.id!==payment.id),payment]}});
 }
 if(form.id==='budget-form')await mutate({action:'budget',category:form.dataset.category||categoryKeys().find(c=>categoryName(c).toLocaleLowerCase('uk')===String(data.get('category')).trim().toLocaleLowerCase('uk'))||data.get('category'),from:`${data.get('fromYear')}-${data.get('fromMonth')}`,amount:toCents(data.get('amount'))});
 if(form.id==='category-form')await mutate({action:'categoryName',category:form.dataset.category,name:data.get('name')});
 if(form.id==='row-form')await mutate({action:'row',id:form.dataset.id,category:data.get('category'),name:data.get('name'),note:data.get('note'),operationType:data.get('operationType'),excluded:data.get('operationType')!=='expense'});
 if(form.id==='collection-form')await mutate({action:'collection',collection:{...(workspace.state.collections.find(c=>c.id===form.dataset.id)??{}),...(workspace.state.collections.find(c=>c.id===form.dataset.id&&c.start===data.get('start')&&c.end===data.get('end'))?.dateLabel?{dateLabel:workspace.state.collections.find(c=>c.id===form.dataset.id).dateLabel}:{dateLabel:undefined,datePrecision:undefined}),purchaseDetails:purchaseItemsFromForm(form),id:form.dataset.id,name:data.get('name'),kind:data.get('kind'),start:data.get('start'),end:data.get('end'),budget:data.get('budget')===''?null:toCents(data.get('budget')),note:data.get('note'),season:data.has('season'),rowIds:[...selectedRowIds],manualPayment:data.get('manualAmount')?{date:data.get('manualDate'),eur:toCents(data.get('manualAmount'))}:null,referenceAmount:form.dataset.reference===''?null:Number(form.dataset.reference)}});
 }catch(error){formError(error);}
});
$('#history').addEventListener('click',()=>showPanel({type:'history'}));
window.addEventListener('beforeunload',event=>{if(!detailPage.hidden&&formBaseline!==formFingerprint()){event.preventDefault();event.returnValue='';}});
async function start(){
 try{
  workspace=await api('/api/workspace');
  const initial=locationNavigation();
  ({page,period}=initial);
  history.scrollRestoration='manual';
  navigation=createNavigation({history,listen:handler=>window.addEventListener('popstate',handler),capture:captureNavigation,restore:restoreNavigation,fallback:locationNavigation,url:navigationUrl,dirty:()=>!detailPage.hidden&&formBaseline!==formFingerprint(),confirm:requestLeave,changed:renderNavigation});
  navigation.start(captureNavigation());
  await selectPeriod(period);capitalHistory=await api('/api/capital-history');render();
 }catch(error){$('#screen').innerHTML='<p class="empty">Не вдалося відкрити дані. Онови сторінку після запуску локального сервера.</p>';failure(error);}
}
start();

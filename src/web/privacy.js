/* Presentation-only privacy. Source values never leave the existing page state. */
const preferenceKey = 'moneywave.hideAmounts';
const number = '[+−–-]?(?:\\d{1,3}(?:[ \\u00a0\\u202f]\\d{3})+|\\d+)(?:[.,]\\d+)*';
const currency = '(?:EUR|USD|UAH|GBP|CHF|PLN|HRK|USDC|USDT|ETH|NEAR|BTC|грн(?:\\.)?)';
const amounts = new RegExp(`(?:[+−–-]?\\s*[€$£₴]\\s*${number}|${number}\\s*(?:${currency}(?![\\p{L}])|%))`, 'gu');

export function maskFinancialText(value) {
 return value.replace(amounts, match => `${match.match(/^\s*/)?.[0] ?? ''}****`);
}

export function amountPreference(storage) {
 try { return storage.getItem(preferenceKey) === 'true'; } catch { return false; }
}

export function createAmountPrivacy({root, button, storage, window}) {
 const document = root.ownerDocument;
 let hidden = amountPreference(storage);
 const texts = new Map(), attributes = new Map();
 const observer = new window.MutationObserver(refresh);
 const observe = () => observer.observe(root, {subtree:true, childList:true, characterData:true, attributes:true, attributeFilter:['title','aria-label']});
 const skip = node => node.parentElement?.closest('script,style,input,textarea,.privacy-mask,#amount-privacy');
 const masked = (value, element) => element?.closest('[data-private]') && /\d/.test(value) ? '****' : maskFinancialText(value);

 function restore() {
  for (const [node, saved] of texts) if (node.isConnected && node.nodeValue === saved.masked) node.nodeValue = saved.original;
  for (const [element, saved] of attributes) if (element.isConnected) for (const [key, value] of Object.entries(saved)) if (element.getAttribute(key) === value.masked) element.setAttribute(key, value.original);
  texts.clear(); attributes.clear();
 }
 function protectFields() {
  for (const input of root.querySelectorAll('input[name=name],input[name=paymentName],textarea[name=note]')) {
   if (maskFinancialText(input.value) !== input.value) input.setAttribute('data-private', '');
  }
  for (const input of root.querySelectorAll('input[data-private],textarea[data-private]')) {
   if (input.parentElement.classList.contains('privacy-field')) continue;
   const wrapper = document.createElement('span'); wrapper.className = 'privacy-field';
   const mask = document.createElement('span'); mask.className = 'privacy-mask'; mask.textContent = '****';
   mask.setAttribute('aria-label', 'Суму приховано');
   input.before(wrapper); wrapper.append(input, mask);
  }
 }
 function refresh() {
  observer.disconnect();
  protectFields();
  root.classList.toggle('amounts-hidden', hidden);
  for (const mask of root.querySelectorAll('.privacy-mask')) mask.setAttribute('aria-hidden', String(!hidden));
  const label = hidden ? 'Показати суми' : 'Приховати суми';
  button.setAttribute('aria-label', label); button.setAttribute('title', label); button.setAttribute('aria-pressed', String(hidden));
  if (!hidden) restore();
  else {
   for (const node of texts.keys()) if (!node.isConnected) texts.delete(node);
   for (const element of attributes.keys()) if (!element.isConnected) attributes.delete(element);
   const walker = document.createTreeWalker(root, window.NodeFilter.SHOW_TEXT);
   for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (skip(node)) continue;
    const current = node.nodeValue;
    if (texts.get(node)?.masked === current) continue;
    const next = masked(current, node.parentElement);
    if (next !== current) {
     // Option text can also be its submitted value; keep that value intact.
     if (node.parentElement?.tagName === 'OPTION' && !node.parentElement.hasAttribute('value')) node.parentElement.value = current;
     texts.set(node, {original:current, masked:next}); node.nodeValue = next;
    } else texts.delete(node);
   }
   for (const element of root.querySelectorAll('[title],[aria-label]')) {
    if (element === button || element.closest('.privacy-mask')) continue;
    const saved = attributes.get(element) ?? {};
    for (const key of ['title','aria-label']) {
     const current = element.getAttribute(key);
     if (current === null || saved[key]?.masked === current) continue;
     const next = maskFinancialText(current);
     if (next !== current) { saved[key] = {original:current,masked:next}; element.setAttribute(key, next); }
     else delete saved[key];
    }
    if (Object.keys(saved).length) attributes.set(element, saved); else attributes.delete(element);
   }
  }
  observe();
 }
 function setHidden(value) {
  hidden = value;
  try { storage.setItem(preferenceKey, String(hidden)); } catch { /* Private browsing may deny storage. */ }
  refresh();
 }
 button.addEventListener('click', () => setHidden(!hidden));
 window.addEventListener('storage', event => { if (event.key === preferenceKey || event.key === null) { hidden = amountPreference(storage); refresh(); } });
 refresh();
 return {refresh};
}

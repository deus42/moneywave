/** User-confirmed category policy; no private identities, dates or financial values. */
export const CATEGORY_POLICY_VERSION = 'personal-categories-2026-09-v3';
export const CATEGORY_POLICY_VERSIONS = new Set(['personal-categories-2026-09-v1', 'personal-categories-2026-09-v2', CATEGORY_POLICY_VERSION]);
export const FORMER_HOME_GROUP = 'Дім, здоров’я та догляд';
// Keep the existing purchase key stable so saved limits, links and older clients still work.
export const PURCHASES_KEY = 'Покупки, техніка, одяг, подарунки, дім';
export const PURCHASES_NAME = 'Покупки, техніка, одяг, дім';
export const HEALTH_BEAUTY_GROUP = 'Здоров’я та краса';
export const CATEGORY_GROUPS: Readonly<Record<string, string>> = {
  coffee: 'Кава', transport: 'Авто', travel: 'Відпустки та подорожі',
  gifts_charity: 'Подарунки', other_payouts: 'Інші виплати', dining: 'Кафе та ресторани', shopping: PURCHASES_KEY, health: HEALTH_BEAUTY_GROUP,
};
const key = (value: string) => value.normalize('NFKC').replace(/[’ʼ`]/gu,"'").toLocaleLowerCase('uk-UA').replace(/\s+/gu,' ').trim();
const groupAliases = new Map(Object.entries({
  'Сімейні виплати':'gifts_charity', 'Подарунки та благодійність':'gifts_charity', 'Подарунки й благодійність':'gifts_charity',
  'Інший транспорт':'transport', 'Авто та пальне':'transport',
  'Догляд':'health', 'Особистий догляд':'health', 'Медицина та аптеки':'health', 'Краса та здоров’я':'health', 'Краса та догляд':'health', 'Здоров’я та добавки':'health', 'Хозтовари':'shopping',
  [FORMER_HOME_GROUP]:'shopping',
  'Спорт':'travel', 'Дозвілля':'travel', 'Дозвілля, спорт':'travel', 'Подорожі':'travel',
  'Повернення без категорії':'other_payouts', 'Кафе, ресторани, кава':'dining',
  [PURCHASES_NAME]:'shopping',
  ...Object.fromEntries(Object.entries(CATEGORY_GROUPS).map(([code,name])=>[name,code])),
}).map(([label,code])=>[key(label),code]));
const codeAliases: Readonly<Record<string,string>> = {
  home:'shopping', pharmacy:'health', medical:'health', personal_care:'health',
  taxi:'transport', public_transport:'transport', fuel:'transport', parking:'transport',
  fitness:'travel', entertainment:'travel', culture:'travel', gaming:'travel',
  clothing:'shopping', electronics:'shopping',
};
export function policyCategoryCode(code: string): string { return Object.hasOwn(codeAliases,code) ? codeAliases[code] : code; }
export function categoryCodeForGroup(group: string): string | undefined { return groupAliases.get(key(group)); }
export function policyCategoryGroup(group: string): string { const code=categoryCodeForGroup(group);return code ? CATEGORY_GROUPS[code] : group; }
export function confirmedMerchantCategory(description: string): {categoryCode:string;ruleId:string}|null {
  const normalized=description.normalize('NFKC');
  if (/(?:^|[^\p{L}\p{N}])(?:coffee[\s._-]*circl(?:e)?|circle[\s._-]*coffee)(?=$|[^\p{L}\p{N}])/iu.test(normalized)) return {categoryCode:'coffee',ruleId:'circle-coffee'};
  if (/(?:^|[^\p{L}\p{N}])(?:müller|mueller|muller)(?=$|[^\p{L}\p{N}])/iu.test(normalized)) return {categoryCode:'shopping',ruleId:'mueller-household'};
  return null;
}

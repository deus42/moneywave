import {createHash} from 'node:crypto';
import {categoryCodeForGroup,policyCategoryCode} from '@/domain/category-policy';
import {CategoryPolicyService,type ConfirmedCategoryRule} from '@/server/categorization/category-policy-service';
import type {EncryptedDatabase} from '@/server/db/database';
import {normalizeReportCategories} from './category-policy';
import {effectiveRows} from './model';
import {WorkspaceStore} from './store';
import {normalizeCategoryAlias} from '@/server/categorization/mcc';

/** Explicit operator capture only. Exact bank merchant descriptors stay encrypted. */
export async function saveWorkspaceMerchantAliases(db:EncryptedDatabase):Promise<{saved:number;ambiguous:number;selected:number}>{
  const workspace=await new WorkspaceStore(db).read();
  const rows=new Map(effectiveRows(normalizeReportCategories(workspace.report),workspace.state).map(row=>[row.id,row]));
  const candidates=new Map<string,{provider:string;label:string;categories:Set<string>}>();
  for(const entry of await db.all<{id:string;provider:string;description:string}>(`SELECT e.id,p.code AS provider,e.private_description AS description
    FROM ledger_entries e JOIN accounts a ON a.id=e.account_id JOIN providers p ON p.id=a.provider_id
    WHERE a.owner_scope='PERSONAL' AND e.direction='debit' AND e.entry_kind='terminal_personal_expense' AND e.private_description IS NOT NULL`)){
    const row=rows.get(entry.id);if(!row||row.excluded)continue;
    const label=normalizeCategoryAlias(entry.description);if(!label||label.length>240)continue;
    const id=JSON.stringify([entry.provider,label]);
    const candidate=candidates.get(id)??{provider:entry.provider,label,categories:new Set<string>()};
    const group=row.baseCategory??row.group;
    candidate.categories.add(categoryCodeForGroup(group)??group);candidates.set(id,candidate);
  }
  return db.transaction(async()=>{
    await new CategoryPolicyService(db).ensureCategories();
    const categories=new Map((await db.all<{id:string;code:string}>("SELECT id,code FROM categories WHERE scope='personal' AND code IN ('shopping','health')")).map(c=>[c.code,c.id]));
    let saved=0,ambiguous=0,selected=0;
    for(const candidate of candidates.values()){
      if(![...candidate.categories].some(code=>categories.has(code)))continue;
      const existing=await db.get<{id:string;code:string}>(`SELECT a.id,c.code FROM category_aliases a JOIN categories c ON c.id=a.category_id WHERE a.provider_code=? AND a.normalized_alias=?`,[candidate.provider,candidate.label]);
      const owned=existing&&/^(?:confirmed-purchase-merchant:|confirmed-category-merchant:)/u.test(existing.id);
      if(candidate.categories.size!==1){
        ambiguous++;
        if(owned)saved+=(await db.run('UPDATE category_aliases SET enabled=0 WHERE id=? AND enabled<>0',[existing.id])).changes;
        continue;
      }
      const code=[...candidate.categories][0],categoryId=categories.get(code);
      if(!categoryId)throw new Error('CATEGORY_RULE_TARGET_NOT_FOUND');
      if(existing&&!owned&&policyCategoryCode(existing.code)!==code){ambiguous++;continue;}
      selected++;
      const id='confirmed-category-merchant:'+createHash('sha256').update(JSON.stringify([candidate.provider,candidate.label])).digest('hex');
      const result=await db.run(`INSERT INTO category_aliases(id,provider_code,normalized_alias,category_id,priority,enabled) VALUES(?,?,?,?,1000,1)
        ON CONFLICT(provider_code,normalized_alias) DO UPDATE SET category_id=excluded.category_id,priority=1000,enabled=1
        WHERE category_id<>excluded.category_id OR priority<>1000 OR enabled<>1`,[id,candidate.provider,candidate.label,categoryId]);
      saved+=result.changes;
    }
    return {saved,ambiguous,selected};
  });
}

/** Optional adapter: processing works without a workspace, and owns only generic exact-entry rules. */
export async function saveWorkspaceCategoryRules(db:EncryptedDatabase):Promise<{saved:number;selected:number}>{
  if(!await db.get('SELECT 1 FROM workspace_state WHERE id=1'))return {saved:0,selected:0};
  const workspace=await new WorkspaceStore(db).read();
  const report=normalizeReportCategories(workspace.report);
  const rules:ConfirmedCategoryRule[]=[];
  const ledgerIds=new Set((await db.all<{id:string}>("SELECT e.id FROM ledger_entries e JOIN accounts a ON a.id=e.account_id WHERE a.owner_scope='PERSONAL'")).map(e=>e.id));
  for(const row of effectiveRows(report,workspace.state)){
    if(!ledgerIds.has(row.id))continue;
    const override=workspace.state.overrides[row.id];
    const confirmedFx=override?.excluded===true&&(override.operationType==='cash_fx'||override.operationType==='fx'||(!override.operationType&&override.category==='Купівля валюти'));
    let categoryCode=confirmedFx?'transfers':categoryCodeForGroup(row.group);
    let displayName:string|undefined;
    if(!categoryCode&&override&&!row.excluded){
      displayName=row.group.normalize('NFC').trim().replace(/\s+/gu,' ');
      categoryCode=`custom_workspace_${createHash('sha256').update(displayName.toLocaleLowerCase('uk')).digest('hex')}`;
    }
    // Other exclusions retain their report semantics; they do not establish ownership or a movement.
    if(!categoryCode||(row.excluded&&!confirmedFx))continue;
    rules.push({entryId:row.id,categoryCode,confirmedFx,...displayName?{displayName}:{}});
  }
  return {...await new CategoryPolicyService(db).saveConfirmedRules(rules),selected:rules.length};
}

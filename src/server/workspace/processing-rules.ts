import {createHash} from 'node:crypto';
import {categoryCodeForGroup} from '@/domain/category-policy';
import {CategoryPolicyService,type ConfirmedCategoryRule} from '@/server/categorization/category-policy-service';
import type {EncryptedDatabase} from '@/server/db/database';
import {normalizeReportCategories} from './category-policy';
import {effectiveRows} from './model';
import {WorkspaceStore} from './store';

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
    const confirmedFx=override?.excluded===true&&override.category==='Купівля валюти';
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

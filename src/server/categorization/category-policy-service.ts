import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {CATEGORY_GROUPS,CATEGORY_POLICY_VERSION,CATEGORY_POLICY_VERSIONS,PURCHASES_NAME,policyCategoryCode} from '@/domain/category-policy';
import {classifyPersonalEntry} from '@/domain/personal-categorization';
import type {EncryptedDatabase} from '@/server/db/database';

const ruleSchema=z.object({type:z.literal('confirmed-entry-category-v1'),entryId:z.string().min(1),confirmedFx:z.boolean()});
export interface ConfirmedCategoryRule {entryId:string;categoryCode:string;confirmedFx:boolean;displayName?:string}
interface Entry {
  id:string; direction:'debit'|'credit'; entryKind:string; description:string|null; sourceCategory:string|null; mcc:string|null;
  categoryCode:string|null; method:string|null; version:string|null; linked:number;
}

/** Persisted exact decisions are local encrypted data; they never imply a matching leg or a balance. */
export class CategoryPolicyService {
  constructor(private readonly db:EncryptedDatabase){}

  async ensureCategories():Promise<void>{
    for(const [code,label] of Object.entries(CATEGORY_GROUPS)){
      await this.db.run(`INSERT INTO categories(id,scope,code,display_name,editable) VALUES(?,?,?,?,1)
        ON CONFLICT(code) DO UPDATE SET display_name=excluded.display_name WHERE categories.scope='personal' AND categories.display_name<>excluded.display_name`,[`personal-${code}`,'personal',code,code==='shopping'?PURCHASES_NAME:label]);
    }
  }

  async saveConfirmedRules(rules:readonly ConfirmedCategoryRule[]):Promise<{saved:number}>{
    return this.db.transaction(async()=>{
      await this.ensureCategories();let saved=0;
      for(const rule of rules){
        if(rule.confirmedFx&&rule.categoryCode!=='transfers')throw new Error('CATEGORY_FX_RULE_INVALID');
        const match=ruleSchema.parse({type:'confirmed-entry-category-v1',entryId:rule.entryId,confirmedFx:rule.confirmedFx});
        const entry=await this.db.get("SELECT e.id FROM ledger_entries e JOIN accounts a ON a.id=e.account_id WHERE e.id=? AND a.owner_scope='PERSONAL'",[rule.entryId]);
        if(!entry)throw new Error('CATEGORY_RULE_ENTRY_NOT_FOUND');
        if(rule.displayName){
          const name=z.string().trim().min(1).max(80).parse(rule.displayName);
          if(!/^custom_workspace_[a-f0-9]{64}$/.test(rule.categoryCode)||/\p{C}/u.test(name))throw new Error('CATEGORY_RULE_TARGET_INVALID');
          await this.db.run("INSERT OR IGNORE INTO categories(id,scope,code,display_name,editable) VALUES(?,'personal',?,?,1)",[rule.categoryCode,rule.categoryCode,name]);
        }
        const category=await this.db.get<{id:string}>("SELECT id FROM categories WHERE scope='personal' AND code=?",[policyCategoryCode(rule.categoryCode)]);
        if(!category)throw new Error('CATEGORY_RULE_TARGET_NOT_FOUND');
        const id=`confirmed-category:${rule.entryId}`,json=JSON.stringify(match);
        const changed=await this.db.run(`INSERT INTO categorization_rules(id,priority,match_json,category_id,enabled) VALUES(?,1000,?,?,1)
          ON CONFLICT(id) DO UPDATE SET match_json=excluded.match_json,category_id=excluded.category_id,enabled=1
          WHERE match_json<>excluded.match_json OR category_id<>excluded.category_id OR enabled<>1`,[id,json,category.id]);
        saved+=changed.changes;
      }
      if(saved)await this.db.run("INSERT INTO audit_events(id,event_code,entity_type,entity_id,safe_details_json) VALUES(?,'CONFIRMED_CATEGORY_RULES_SAVED','category_policy',?,?)",[randomUUID(),CATEGORY_POLICY_VERSION,JSON.stringify({saved})]);
      return {saved};
    });
  }

  async apply(entryId?:string):Promise<{assigned:number;excluded:number;manualPreserved:number}>{
    return this.db.transaction(async()=>{
      await this.ensureCategories();
      const rules=new Map<string,ConfirmedCategoryRule>();
      for(const row of await this.db.all<{match:string;code:string}>(`SELECT r.match_json AS match,c.code FROM categorization_rules r JOIN categories c ON c.id=r.category_id
        WHERE r.enabled=1 AND json_extract(r.match_json,'$.type')='confirmed-entry-category-v1' ORDER BY r.priority,r.id`)){
        const match=ruleSchema.parse(JSON.parse(row.match));
        if(match.confirmedFx&&row.code!=='transfers')throw new Error('CATEGORY_FX_RULE_INVALID');
        rules.set(match.entryId,{...match,categoryCode:row.code});
      }
      const categories=new Map((await this.db.all<{id:string;code:string}>("SELECT id,code FROM categories WHERE scope='personal'")).map(c=>[c.code,c.id]));
      const entries=await this.db.all<Entry>(`SELECT e.id,e.direction,e.entry_kind AS entryKind,e.private_description AS description,
        c.code AS categoryCode,assignment.method,assignment.classification_version AS version,
        EXISTS(SELECT 1 FROM movement_legs WHERE ledger_entry_id=e.id) AS linked,
        (SELECT COALESCE(json_extract(s.source_metadata_json,'$.sourceCategory'),json_extract(s.source_metadata_json,'$.statementCategory')) FROM transaction_evidence t JOIN source_records s ON s.id=t.source_record_id WHERE t.ledger_entry_id=e.id ORDER BY t.rowid LIMIT 1) AS sourceCategory,
        (SELECT json_extract(s.source_metadata_json,'$.mcc') FROM transaction_evidence t JOIN source_records s ON s.id=t.source_record_id WHERE t.ledger_entry_id=e.id ORDER BY t.rowid LIMIT 1) AS mcc
        FROM ledger_entries e JOIN accounts a ON a.id=e.account_id
        LEFT JOIN category_assignments assignment ON assignment.rowid=(SELECT rowid FROM category_assignments WHERE ledger_entry_id=e.id ORDER BY assigned_at DESC,rowid DESC LIMIT 1)
        LEFT JOIN categories c ON c.id=assignment.category_id WHERE a.owner_scope='PERSONAL' AND (? IS NULL OR e.id=?) ORDER BY e.id`,[entryId??null,entryId??null]);
      const counts={assigned:0,excluded:0,manualPreserved:0};
      for(const entry of entries){
        const exact=rules.get(entry.id);
        if(entry.method==='manual'||(entry.method==='user_rule'&&!CATEGORY_POLICY_VERSIONS.has(entry.version??''))){counts.manualPreserved++;continue;}
        let code:string|undefined,ruleId:string|undefined;
        if(exact?.confirmedFx){
          // A user-confirmed currency purchase is a non-spending movement. Do not fabricate its other leg.
          code='transfers';ruleId='confirmed-fx';
          if(!entry.linked&&['unclassified','terminal_personal_expense','personal_income','unlinked_transfer_in','unlinked_transfer_out'].includes(entry.entryKind)){
            const kind=entry.direction==='debit'?'unlinked_transfer_out':'unlinked_transfer_in';
            if(entry.entryKind!==kind){await this.db.run('UPDATE ledger_entries SET entry_kind=? WHERE id=?',[kind,entry.id]);counts.excluded++;}
          }
        }else if(!entry.linked&&['unclassified','terminal_personal_expense','personal_income'].includes(entry.entryKind)){
          if(exact){code=policyCategoryCode(exact.categoryCode);ruleId='confirmed-entry';}
          else if(entry.direction==='debit'){
            const result=classifyPersonalEntry(entry);
            if(result.state==='assigned'&&result.method==='user_rule'){code=result.categoryCode;ruleId='confirmed-category-policy';}
            else if(entry.categoryCode&&policyCategoryCode(entry.categoryCode)!==entry.categoryCode){code=policyCategoryCode(entry.categoryCode);ruleId='category-merge';}
          }
        }
        if(!code||!ruleId||(entry.categoryCode===code&&entry.version===CATEGORY_POLICY_VERSION))continue;
        const categoryId=categories.get(code);if(!categoryId)throw new Error('CATEGORY_RULE_TARGET_NOT_FOUND');
        await this.db.run(`INSERT INTO category_assignments(id,ledger_entry_id,category_id,method,confidence_text,needs_review,classification_version,evidence_json)
          VALUES(?,?,?,'user_rule','1',0,?,?)`,[randomUUID(),entry.id,categoryId,CATEGORY_POLICY_VERSION,JSON.stringify({policyVersion:CATEGORY_POLICY_VERSION,ruleId})]);
        if(code!=='transfers'&&entry.direction==='debit'&&entry.entryKind==='unclassified'){
          await this.db.run(`UPDATE ledger_entries SET entry_kind='terminal_personal_expense' WHERE id=? AND entry_kind='unclassified'
            AND NOT EXISTS(SELECT 1 FROM movement_candidates WHERE status IN ('pending','confirmed') AND (debit_entry_id=? OR credit_entry_id=?))`,[entry.id,entry.id,entry.id]);
        }
        counts.assigned++;
      }
      if(counts.assigned||counts.excluded)await this.db.run("INSERT INTO audit_events(id,event_code,entity_type,entity_id,safe_details_json) VALUES(?,'CONFIRMED_CATEGORY_POLICY_APPLIED','category_policy',?,?)",[randomUUID(),CATEGORY_POLICY_VERSION,JSON.stringify(counts)]);
      return counts;
    });
  }
}

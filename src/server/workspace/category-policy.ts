import {CATEGORY_GROUPS,CATEGORY_POLICY_VERSION,HEALTH_BEAUTY_GROUP,PURCHASES_KEY,PURCHASES_NAME,confirmedMerchantCategory,policyCategoryGroup} from '@/domain/category-policy';
import {budgetFor,reportSchema,stateSchema,type WorkspaceReport,type WorkspaceState} from './model';

export function normalizeReportCategories(input: WorkspaceReport): WorkspaceReport {
  const report=structuredClone(input);
  const plans=new Map<string,bigint>();
  for(const [name,amount] of Object.entries(report.plan)){const group=policyCategoryGroup(name);plans.set(group,(plans.get(group)??0n)+BigInt(amount));}
  report.plan=Object.fromEntries([...plans].map(([name,amount])=>[name,Number(amount)]));
  for(const row of report.rows){
    const before=row.homeGroup??row.group;
    let group=policyCategoryGroup(before),rule='category-merge';
    const merchant=confirmedMerchantCategory(row.description);
    if(group!=='Інші виплати'&&merchant){group=CATEGORY_GROUPS[merchant.categoryCode];rule=merchant.ruleId;}
    else if(group===PURCHASES_KEY&&policyCategoryGroup(row.originalCategory??'')==='Подарунки'){group='Подарунки';rule='source-gifts';}
    else if(group===PURCHASES_KEY&&policyCategoryGroup(row.originalCategory??'')===HEALTH_BEAUTY_GROUP){group=HEALTH_BEAUTY_GROUP;rule='source-health-beauty';}
    row.group=policyCategoryGroup(row.group);
    if(group!==before){row.homeGroup=group;row.group=group;row.categoryPolicy={version:CATEGORY_POLICY_VERSION,rule};}
  }
  const byId=new Map(report.rows.map(r=>[r.id,r]));
  for(const row of report.rows)if(row.purchaseId){const parent=byId.get(row.purchaseId);if(parent){const group=parent.homeGroup??parent.group;if((row.homeGroup??row.group)!==group){row.group=group;row.homeGroup=group;row.categoryPolicy={version:CATEGORY_POLICY_VERSION,rule:'linked-refund'};}}}
  return reportSchema.parse(report);
}

export function normalizeWorkspaceCategories(report: WorkspaceReport,input: WorkspaceState): WorkspaceState {
  const state=structuredClone(input),keys=[...new Set([...Object.keys(report.plan),...state.budgets.map(b=>b.category)])];
  if(keys.some(k=>policyCategoryGroup(k)!==k))state.budgets=[...new Set(keys.map(policyCategoryGroup))].flatMap(category=>{
    const members=keys.filter(k=>policyCategoryGroup(k)===category);
    const versions=input.budgets.filter(b=>members.includes(b.category));
    const mergingPurchases=category===PURCHASES_KEY&&members.some(k=>k!==category);
    if(!mergingPurchases&&versions.every(b=>b.category===category))return versions;
    return [...new Set(versions.map(b=>b.from))].sort().map(from=>{
      const combined=input.budgets.filter(b=>b.category===category&&b.from<=from).sort((a,b)=>b.from.localeCompare(a.from))[0];
      // Purchases was already a live category before the home/care merge. Its
      // saved limit is a component, not a limit for the newly combined group.
      return {category,from,amount:!mergingPurchases&&combined?budgetFor(report,input,category,from):members.reduce((sum,k)=>sum+budgetFor(report,input,k,from),0)};
    });
  });
  for(const override of Object.values(state.overrides))override.category=policyCategoryGroup(override.category);
  for(const split of Object.values(state.operationSplits??{}))for(const part of split.parts)part.category=policyCategoryGroup(part.category);
  for(const expense of state.cashExpenses)expense.category=policyCategoryGroup(expense.category);
  state.categoryNames={};
  for(const [original,name] of Object.entries(input.categoryNames)){
    const category=policyCategoryGroup(original);
    if(category===PURCHASES_KEY&&original!==PURCHASES_KEY)continue;
    if(Object.hasOwn(state.categoryNames,category)&&state.categoryNames[category]!==name)throw new Error('CATEGORY_POLICY_NAME_CONFLICT');
    state.categoryNames[category]=name;
  }
  if(!Object.hasOwn(state.categoryNames,PURCHASES_KEY)&&(Object.hasOwn(report.plan,PURCHASES_KEY)||report.rows.some(r=>(r.homeGroup??r.group)===PURCHASES_KEY)))state.categoryNames[PURCHASES_KEY]=PURCHASES_NAME;
  return stateSchema.parse(state);
}

export function inheritNewRefundCorrections(report:WorkspaceReport,state:WorkspaceState):void {
  for(const row of report.rows){
    const parent=row.purchaseId&&Object.hasOwn(state.overrides,row.purchaseId)?state.overrides[row.purchaseId]:undefined;
    if(parent&&!Object.hasOwn(state.overrides,row.id))state.overrides[row.id]={category:parent.category,excluded:parent.excluded,note:''};
  }
}

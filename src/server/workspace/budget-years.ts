import {annualComparison,budgetFor,effectiveRows,exactSum,type WorkspaceReport,type WorkspaceState} from './model';

/** Full annual plans and the available actuals; incomplete years have no outcome verdict. */
export function budgetYears(report:WorkspaceReport,state:WorkspaceState,today:string){
  const years=new Set(report.months.map(m=>Number(m.month.slice(0,4))));
  for(const budget of state.budgets){
    const first=Number(budget.from.slice(0,4)),last=Number((budget.to??today).slice(0,4));
    for(let year=first;year<=Math.max(first,last);year++)years.add(year);
  }
  const keys=[...new Set([...Object.keys(report.plan),...state.budgetCategories,...state.budgets.map(b=>b.category),...effectiveRows(report,state).map(r=>r.group)])];
  return [...years].filter(year=>year>=1901&&year<=9998).sort((a,b)=>a-b).map(year=>{
    const actual=annualComparison(report,state,{mode:'calendar',year}).current;
    const months=report.months.filter(m=>m.month.startsWith(String(year))&&!m.manualOnly);
    const complete=actual.complete&&months.every(m=>!m.partial)&&`${year}-12-31`<=today;
    const categories=[...new Set([...keys,...Object.keys(actual.categories)])].map(category=>{
      const plan=exactSum(Array.from({length:12},(_,i)=>budgetFor(report,state,category,`${year}-${String(i+1).padStart(2,'0')}`)));
      const value=actual.net===null?null:Object.hasOwn(actual.categories,category)?actual.categories[category]:0;
      return {category,plan,actual:value,variance:complete&&value!==null?exactSum([value,-plan]):null};
    }).filter(c=>c.plan!==0||c.actual!==0&&c.actual!==null);
    const plan=exactSum(categories.map(c=>c.plan));
    return {year,plan,actual:actual.net,variance:complete&&actual.net!==null?exactSum([actual.net,-plan]):null,
      monthlyPlan:plan/12,monthlyActual:complete&&actual.net!==null?actual.net/12:null,
      complete,coveredMonths:months.length,from:actual.coveredFrom,to:actual.coveredTo,categories};
  });
}

import { createHash } from 'node:crypto';
import {cryptoHistorySchema} from './crypto-history';
import type { EncryptedDatabase } from '@/server/db/database';
import { changeState, initialState, isCashflowRow, mutationSchema, reportSchema, stateSchema, type WorkspaceReport, type WorkspaceState } from './model';
import {inheritNewRefundCorrections,normalizeReportCategories,normalizeWorkspaceCategories} from './category-policy';
import {cashAccounts,prepareCashExpense} from './cash-expenses';
import {cashHistory} from './cash-history';

export async function ledgerFingerprint(db: EncryptedDatabase): Promise<string> {
  const hash = createHash('sha256');
  for (const table of ['ledger_entries','source_records','import_artifacts','balance_snapshots','category_assignments','movement_groups','movement_legs','cost_components','manual_position_facts']) {
    hash.update(table);
    // Hash the entire original evidence locally, including bytes, without logging it.
    for (const row of await db.all<Record<string, unknown>>(`SELECT * FROM ${table} ORDER BY rowid`)) hash.update(JSON.stringify(row));
  }
  return hash.digest('hex');
}

export class WorkspaceStore {
  #queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly db: EncryptedDatabase, private readonly now = () => new Date()) {}
  cashAccounts(){return cashAccounts(this.db);}
  cashHistory(){return cashHistory(this.db,this.now().toISOString().slice(0,10));}
  async read() {
    const row = await this.db.get<{revision:number; state:string; report:string; digest:string}>(`
      SELECT s.revision, s.payload_json AS state, r.payload_json AS report, r.digest
      FROM workspace_state s JOIN workspace_reports r ON r.digest=s.report_digest WHERE s.id=1`);
    if (!row) throw new Error('WORKSPACE_NOT_INITIALIZED');
    const state=stateSchema.parse(JSON.parse(row.state));
    // Older released readers strip unknown overlay fields on save. The existing
    // append-only cash action history preserves the authoritative facts, including undo.
    const cashJournal=await this.db.get<{payload:string}>(`SELECT CASE WHEN h.action='undo' THEN p.before_json ELSE h.after_json END AS payload
      FROM workspace_history h LEFT JOIN workspace_history p ON p.revision=h.revision-1
      WHERE h.revision<=? AND (h.action IN ('cashExpense','deleteCashExpense')
        OR (h.action='undo' AND p.action IN ('cashExpense','deleteCashExpense')))
      ORDER BY h.revision DESC LIMIT 1`,[row.revision]);
    if(cashJournal)state.cashExpenses=stateSchema.parse(JSON.parse(cashJournal.payload)).cashExpenses;
    return { revision: row.revision, digest: row.digest, report: reportSchema.parse(JSON.parse(row.report)), state };
  }
  async seed(input: WorkspaceReport, refresh = false) {
    const report = normalizeReportCategories(reportSchema.parse(input));
    const existing = await this.db.get<{report_digest:string}>('SELECT report_digest FROM workspace_state WHERE id=1');
    if(existing&&report.cryptoHistory===undefined)report.cryptoHistory=(await this.read()).report.cryptoHistory;
    const payload = JSON.stringify(report), digest = createHash('sha256').update(payload).digest('hex');
    if (existing) {
      const current = await this.read();
      if (JSON.stringify(current.report) === payload) return { inserted: false, digest: existing.report_digest };
      if (!refresh) throw new Error('WORKSPACE_ALREADY_INITIALIZED');
    }
    const uniqueIds = new Set(report.rows.map(r => r.id));
    if (uniqueIds.size !== report.rows.length) throw new Error('DUPLICATE_REPORT_ROW');
    for (const m of report.months) {
      const actual = report.rows.filter(r => r.date.startsWith(m.month) && isCashflowRow(r)).reduce((a,r) => a + BigInt(r.eur),0n);
      if (actual !== BigInt(m.grossSpending)) throw new Error('REPORT_MONTH_MISMATCH');
    }
    if (existing) {
      await this.db.transaction(async () => {
        const current = await this.read();
        const referenced = [...Object.keys(current.state.overrides), ...current.state.collections.flatMap(c=>c.rowIds)];
        if (referenced.some(id=>!uniqueIds.has(id))) throw new Error('REFRESH_WOULD_ORPHAN_EDITS');
        let next = normalizeWorkspaceCategories(current.report,current.state);
        for (const c of report.collections) {
          const edited = next.collections.find(old=>old.id===c.id);
          const oldSource = current.report.collections.find(old=>old.id===c.id);
          if (!edited || (oldSource && JSON.stringify(edited) === JSON.stringify(oldSource))) next = changeState(report,next,{action:'collection',revision:current.revision,collection:c});
        }
        inheritNewRefundCorrections(report,next);
        await this.db.run('INSERT OR IGNORE INTO workspace_reports(digest,payload_json) VALUES(?,?)',[digest,payload]);
        await this.db.run('INSERT INTO workspace_history(revision,action,before_json,after_json) VALUES(?,?,?,?)',[current.revision+1,'report_refresh',JSON.stringify(current.state),JSON.stringify(next)]);
        await this.db.run('UPDATE workspace_state SET report_digest=?,revision=?,payload_json=? WHERE id=1',[digest,current.revision+1,JSON.stringify(next)]);
      });
      return { inserted: true, digest };
    }
    let state = normalizeWorkspaceCategories(report,initialState(report));
    state.collections = [];
    for (const collection of report.collections) state = changeState(report,state,{action:'collection',revision:0,collection});
    await this.db.transaction(async () => {
      await this.db.run('INSERT INTO workspace_reports(digest,payload_json) VALUES(?,?)',[digest,payload]);
      await this.db.run('INSERT INTO workspace_state(id,report_digest,revision,payload_json) VALUES(1,?,0,?)',[digest,JSON.stringify(state)]);
    });
    return { inserted: true, digest };
  }
  /** Operator-only after a verified backup; preserve report and overlay bytes outside this field. */
  async installCryptoHistory(input:unknown,expectedRevision:number){
    const history=cryptoHistorySchema.parse(input);
    const pending=this.#queue.then(()=>this.db.transaction(async()=>{
      const current=await this.db.get<{revision:number;report:string;state:string}>(`SELECT s.revision,r.payload_json AS report,s.payload_json AS state FROM workspace_state s JOIN workspace_reports r ON r.digest=s.report_digest WHERE s.id=1`);
      if(!current)throw new Error('WORKSPACE_NOT_INITIALIZED');
      if(current.revision!==expectedRevision)throw new Error('REVISION_CONFLICT');
      const report=JSON.parse(current.report);
      if(JSON.stringify(report.cryptoHistory)===JSON.stringify(history))return {revision:current.revision,inserted:false};
      const payload=JSON.stringify({...report,cryptoHistory:history}),digest=createHash('sha256').update(payload).digest('hex');
      await this.db.run('INSERT OR IGNORE INTO workspace_reports(digest,payload_json) VALUES(?,?)',[digest,payload]);
      await this.db.run('INSERT INTO workspace_history(revision,action,before_json,after_json) VALUES(?,?,?,?)',[current.revision+1,'report_refresh',current.state,current.state]);
      await this.db.run('UPDATE workspace_state SET report_digest=?,revision=? WHERE id=1',[digest,current.revision+1]);
      return {revision:current.revision+1,inserted:true};
    }));
    this.#queue=pending.catch(()=>undefined);
    return pending;
  }
  async history() {
    return this.db.all<{revision:number; action:string; createdAt:string}>('SELECT revision,action,created_at AS createdAt FROM workspace_history ORDER BY revision DESC LIMIT 30');
  }
  /** Operator-only, backed-up reconciliation. A report and its reviewed overlay move together. */
  async reconcile(input: WorkspaceReport, overlay: WorkspaceState, expectedRevision: number) {
    const report=normalizeReportCategories(reportSchema.parse(input));
    if(report.cryptoHistory===undefined)report.cryptoHistory=(await this.read()).report.cryptoHistory;
    if(report.version!==2)throw new Error('RECONCILIATION_VERSION_REQUIRED');
    const state=stateSchema.parse(overlay),ids=new Set(report.rows.map(r=>r.id));
    if(ids.size!==report.rows.length)throw new Error('DUPLICATE_REPORT_ROW');
    for(const month of report.months)if(report.rows.filter(r=>isCashflowRow(r)&&r.date.startsWith(month.month)).reduce((n,r)=>n+BigInt(r.eur),0n)!==BigInt(month.grossSpending))throw new Error('REPORT_MONTH_MISMATCH');
    if(Object.keys(state.overrides).some(id=>!ids.has(id)))throw new Error('REFRESH_WOULD_ORPHAN_EDITS');
    let validated={...state,collections:[] as WorkspaceState['collections']};
    for(const collection of state.collections)validated=changeState(report,validated,{action:'collection',revision:expectedRevision,collection});
    const payload=JSON.stringify(report),digest=createHash('sha256').update(payload).digest('hex');
    const pending=this.#queue.then(()=>this.db.transaction(async()=>{
      const current=await this.read();
      if(current.revision!==expectedRevision)throw new Error('REVISION_CONFLICT');
      if(current.report.ledgerDigest!==report.ledgerDigest)throw new Error('REPORT_LEDGER_CHANGED');
      if([...Object.keys(current.state.overrides),...current.state.collections.flatMap(c=>c.rowIds)].some(id=>!ids.has(id)))throw new Error('REFRESH_WOULD_ORPHAN_EDITS');
      if(current.digest===digest&&JSON.stringify(current.state)===JSON.stringify(validated))return {revision:current.revision,digest,inserted:false};
      await this.db.run('INSERT OR IGNORE INTO workspace_reports(digest,payload_json) VALUES(?,?)',[digest,payload]);
      await this.db.run('INSERT INTO workspace_history(revision,action,before_json,after_json) VALUES(?,?,?,?)',[current.revision+1,'report_refresh',JSON.stringify(current.state),JSON.stringify(validated)]);
      await this.db.run('UPDATE workspace_state SET report_digest=?,revision=?,payload_json=? WHERE id=1',[digest,current.revision+1,JSON.stringify(validated)]);
      return {revision:current.revision+1,digest,inserted:true};
    }));
    this.#queue=pending.catch(()=>undefined);
    return pending;
  }
  mutate(input: unknown): Promise<{revision:number}> {
    const mutation = mutationSchema.parse(input);
    const pending = this.#queue.then(() => this.db.transaction(async () => {
      const current = await this.read();
      if (mutation.revision !== current.revision) throw new Error('REVISION_CONFLICT');
      if (mutation.action === 'collection' && mutation.collection.manualPayment && mutation.collection.manualPayment.date > this.now().toISOString().slice(0,10)) throw new Error('FUTURE_MANUAL_PAYMENT');
      if (mutation.action === 'collection' && mutation.collection.payments?.some(p=>p.date>this.now().toISOString().slice(0,p.date.length))) throw new Error('FUTURE_MANUAL_PAYMENT');
      let next;
      if (mutation.action === 'undo') {
        const previous = await this.db.get<{before_json:string;action:string}>('SELECT before_json,action FROM workspace_history WHERE revision=?',[current.revision]);
        if (!previous || ['undo','report_refresh'].includes(previous.action)) throw new Error('NOTHING_TO_UNDO');
        next = stateSchema.parse(JSON.parse(previous.before_json));
        if(!['cashExpense','deleteCashExpense'].includes(previous.action))next.cashExpenses=current.state.cashExpenses;
      } else if(mutation.action==='cashExpense'){
        const previous=current.state.cashExpenses.find(e=>e.id===mutation.expense.id);
        if(mutation.mode==='create'&&previous)throw new Error('CASH_EXPENSE_EXISTS');
        if(mutation.mode==='update'&&!previous)throw new Error('CASH_EXPENSE_NOT_FOUND');
        const expense=await prepareCashExpense(this.db,mutation.expense,this.now().toISOString().slice(0,10),previous);
        next=stateSchema.parse({...current.state,cashExpenses:[...current.state.cashExpenses.filter(e=>e.id!==expense.id),expense]});
      } else next = changeState(current.report,current.state,mutation);
      const revision = current.revision + 1;
      await this.db.run('INSERT INTO workspace_history(revision,action,before_json,after_json) VALUES(?,?,?,?)',[revision,mutation.action,JSON.stringify(current.state),JSON.stringify(next)]);
      await this.db.run('UPDATE workspace_state SET revision=?,payload_json=? WHERE id=1',[revision,JSON.stringify(next)]);
      return {revision};
    }));
    this.#queue = pending.catch(() => undefined);
    return pending;
  }
}

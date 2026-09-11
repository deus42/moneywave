import { createHash } from 'node:crypto';
import type { EncryptedDatabase } from '@/server/db/database';
import { changeState, initialState, mutationSchema, reportSchema, stateSchema, type WorkspaceReport } from './model';
import {inheritNewRefundCorrections,normalizeReportCategories,normalizeWorkspaceCategories} from './category-policy';

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
  async read() {
    const row = await this.db.get<{revision:number; state:string; report:string; digest:string}>(`
      SELECT s.revision, s.payload_json AS state, r.payload_json AS report, r.digest
      FROM workspace_state s JOIN workspace_reports r ON r.digest=s.report_digest WHERE s.id=1`);
    if (!row) throw new Error('WORKSPACE_NOT_INITIALIZED');
    return { revision: row.revision, digest: row.digest, report: reportSchema.parse(JSON.parse(row.report)), state: stateSchema.parse(JSON.parse(row.state)) };
  }
  async seed(input: WorkspaceReport, refresh = false) {
    const report = normalizeReportCategories(reportSchema.parse(input));
    const payload = JSON.stringify(report), digest = createHash('sha256').update(payload).digest('hex');
    const existing = await this.db.get<{report_digest:string}>('SELECT report_digest FROM workspace_state WHERE id=1');
    if (existing) {
      const current = await this.read();
      if (JSON.stringify(current.report) === payload) return { inserted: false, digest: existing.report_digest };
      if (!refresh) throw new Error('WORKSPACE_ALREADY_INITIALIZED');
    }
    const uniqueIds = new Set(report.rows.map(r => r.id));
    if (uniqueIds.size !== report.rows.length) throw new Error('DUPLICATE_REPORT_ROW');
    for (const m of report.months) {
      const actual = report.rows.filter(r => r.date.startsWith(m.month) && !r.excluded).reduce((a,r) => a + BigInt(r.eur),0n);
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
  async history() {
    return this.db.all<{revision:number; action:string; createdAt:string}>('SELECT revision,action,created_at AS createdAt FROM workspace_history ORDER BY revision DESC LIMIT 30');
  }
  mutate(input: unknown): Promise<{revision:number}> {
    const mutation = mutationSchema.parse(input);
    const pending = this.#queue.then(() => this.db.transaction(async () => {
      const current = await this.read();
      if (mutation.revision !== current.revision) throw new Error('REVISION_CONFLICT');
      if (mutation.action === 'collection' && mutation.collection.manualPayment && mutation.collection.manualPayment.date > this.now().toISOString().slice(0,10)) throw new Error('FUTURE_MANUAL_PAYMENT');
      let next;
      if (mutation.action === 'undo') {
        const previous = await this.db.get<{before_json:string;action:string}>('SELECT before_json,action FROM workspace_history WHERE revision=?',[current.revision]);
        if (!previous || ['undo','report_refresh'].includes(previous.action)) throw new Error('NOTHING_TO_UNDO');
        next = stateSchema.parse(JSON.parse(previous.before_json));
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

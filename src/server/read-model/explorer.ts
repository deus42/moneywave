import type { InspectorTarget } from "@/domain/explorer";
import type { ReportCurrency } from "@/domain/reporting";
import type { EncryptedDatabase } from "@/server/db/database";
import { FinanceCenters, type CapitalPosition } from "./finance-centers";
import { MoneyWaveReadRepository, type MovementChainView, type TransactionPageView, type TransactionView } from "./repository";

export interface SourceEvidenceView {
  id: string; row: number; parser: string; version: string; state: string;
  amountMinor: string; currency: string; direction: string;
}
export interface FxEvidenceView {
  soldMinor: string; soldCurrency: string; receivedMinor: string; receivedCurrency: string;
  executedRate: string; benchmarkRate: string | null; benchmarkSource: string | null;
  publicationDate: string | null; formulaVersion: string;
}
export type ExplorerDetails =
  | { kind: "transaction"; transaction: TransactionView; sources: SourceEvidenceView[]; movement: MovementChainView | null; fx: FxEvidenceView | null }
  | { kind: "movement"; movement: MovementChainView; fx: FxEvidenceView | null }
  | { kind: "account"; position: CapitalPosition; asOf: string; history: Array<{ asOf: string; position: CapitalPosition }>; transactions: TransactionPageView | null };

/** Addressed, allowlisted projections only. Never returns raw artifacts or source metadata JSON. */
export class FinanceExplorer {
  private readonly repository: MoneyWaveReadRepository;
  private readonly centers: FinanceCenters;
  constructor(private readonly database: EncryptedDatabase, now = () => new Date()) {
    this.repository = new MoneyWaveReadRepository(database, now);
    this.centers = new FinanceCenters(database, now);
  }

  private async fx(id: string): Promise<FxEvidenceView | null> {
    return await this.database.get<FxEvidenceView>(`SELECT CAST(sold_amount_minor AS TEXT) AS soldMinor,
      sold_currency AS soldCurrency, CAST(received_amount_minor AS TEXT) AS receivedMinor,
      received_currency AS receivedCurrency, executed_rate_text AS executedRate,
      benchmark_rate_text AS benchmarkRate, benchmark_source AS benchmarkSource,
      benchmark_publication_date AS publicationDate, formula_version AS formulaVersion
      FROM fx_conversions WHERE movement_group_id = ?`, [id]) ?? null;
  }

  async details(target: InspectorTarget, currency: ReportCurrency, asOf?: string, page = 1): Promise<ExplorerDetails | null> {
    if (target.kind === "transaction") {
      const transaction = await this.repository.transactionById(target.id, currency);
      if (!transaction) return null;
      const sources = await this.database.all<SourceEvidenceView>(`SELECT evidence.id,
        record.source_row_number AS row, artifact.parser_kind AS parser, artifact.parser_version AS version,
        record.row_state AS state, CAST(evidence.observed_amount_minor AS TEXT) AS amountMinor,
        evidence.observed_currency AS currency, evidence.observed_direction AS direction
        FROM transaction_evidence evidence JOIN source_records record ON record.id = evidence.source_record_id
        JOIN import_batches batch ON batch.id = record.batch_id JOIN import_artifacts artifact ON artifact.id = batch.artifact_id
        WHERE evidence.ledger_entry_id = ? ORDER BY artifact.imported_at, record.source_row_number, evidence.id`, [target.id]);
      const movement = transaction.movementGroupId ? await this.repository.movementById(transaction.movementGroupId, currency) : null;
      return { kind: "transaction", transaction, sources, movement, fx: movement ? await this.fx(movement.id) : null };
    }
    if (target.kind === "movement") {
      const movement = await this.repository.movementById(target.id, currency);
      return movement ? { kind: "movement", movement, fx: await this.fx(movement.id) } : null;
    }
    const view = await this.centers.capital(asOf, currency);
    const position = view.positions.find((item) => item.id === target.id);
    if (!position) return null;
    const history: Array<{ asOf: string; position: CapitalPosition }> = [];
    // Reuse the same source precedence and exact valuation, bounded to two years.
    for (let offset = 23; offset >= 0; offset--) {
      const date = new Date(`${view.asOf.slice(0, 7)}-01T00:00:00Z`);
      date.setUTCMonth(date.getUTCMonth() - offset + 1, 0);
      const day = date.toISOString().slice(0, 10);
      if (day > view.asOf) continue;
      const historical = (await this.centers.capital(day, currency)).positions.find((item) => item.id === target.id);
      if (historical && historical.source) history.push({ asOf: day, position: historical });
    }
    const end = new Date(`${view.asOf}T00:00:00Z`); end.setUTCDate(end.getUTCDate() + 1);
    const transactions = position.accountId ? await this.repository.transactionPage({ accountId: position.accountId,
      reportCurrency: currency, to: end.toISOString(), page, pageSize: 25 }) : null;
    return { kind: "account", position, asOf: view.asOf, history, transactions };
  }
}

export type SourceRowState = "posted" | "non_posted" | "unresolved" | "rejected";
export type EntryDirection = "credit" | "debit";
export type RowDirection = EntryDirection | "internal" | "evidence_only";
export type OwnerScope = "PERSONAL" | "SOLE_PROPRIETOR";

export interface OwnershipTarget {
  accountId: string;
  instrumentId?: string;
  instrumentIdentifierHash?: string;
  ownerScope?: OwnerScope;
}

export interface OwnershipContext {
  ownership: ReadonlyMap<string, OwnershipTarget>;
  mappingComplete: boolean;
}

export interface NormalizedObservation {
  id: string;
  sourceRecordId: string;
  provider: string;
  accountId: string;
  instrumentId?: string;
  instrumentIdentifierHash?: string;
  ownerScope?: OwnerScope;
  direction: EntryDirection;
  amountMinor: bigint;
  currency: string;
  sourceAmountMinor?: bigint;
  sourceCurrency?: string;
  resultingBalanceMinor?: bigint;
  resultingBalanceCurrency?: string;
  occurredAt: string;
  ownIdentifierHash: string;
  counterpartyIdentifierHash?: string;
  providerReference?: string;
  description?: string;
  sourceCategory?: string;
  explicitFeeMinor?: bigint;
  explicitFeeCurrency?: string;
}

export type UndatedObservation = Omit<NormalizedObservation, "occurredAt">;

export interface NormalizedSourceRow {
  sourceRowNumber: number;
  sourceRecordId: string;
  dedupeFingerprint: string;
  state: SourceRowState;
  reasonCode?: string;
  direction?: RowDirection;
  observations: NormalizedObservation[];
  undatedObservations?: UndatedObservation[];
  sourceMetadata: Record<string, string | null>;
}

export interface NormalizationResult {
  kind: "privat_personal" | "privat_fop_journal" | "monobank_personal" | "erste_personal" | "wise_personal" | "revolut_personal";
  rows: NormalizedSourceRow[];
}

export interface ProbeResult {
  matched: boolean;
  kind?: NormalizationResult["kind"];
  reasonCode?: string;
}

export interface ReconciliationSummary {
  rowCount: number;
  coveredRowCount: number;
  silentlySkippedRowCount: number;
  stateCounts: Record<SourceRowState, number>;
  issues: string[];
}

export interface StatementAdapter<Parsed> {
  probe(input: Buffer): ProbeResult;
  parse(input: Buffer): Parsed;
  normalize(parsed: Parsed, context: OwnershipContext): NormalizationResult;
  reconcile(normalized: NormalizationResult): ReconciliationSummary;
}

export interface SyncCapability {
  available: boolean;
  reasonCode?: string;
}

export interface SyncAccountDescriptor {
  providerAccountId: string;
  maskedDisplay: string;
  currency: string;
}

export interface SyncPage<ProviderTransaction> {
  transactions: ProviderTransaction[];
  nextCursor: string | null;
}

export interface SyncAdapter<ProviderTransaction> {
  checkCapability(): Promise<SyncCapability>;
  listAccounts(): Promise<SyncAccountDescriptor[]>;
  fetchTransactions(input: {
    providerAccountId: string;
    cursor: string | null;
    from: string;
    to: string;
  }): Promise<SyncPage<ProviderTransaction>>;
}

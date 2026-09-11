import type {
  NormalizationResult,
  OwnershipContext,
  ProbeResult,
  ReconciliationSummary,
  StatementAdapter,
} from "./types";

export interface DiscoveredImportIdentifier {
  identifierHash: string;
  display: string;
  currencies: string[];
  identifierKind: "account" | "instrument";
  instrumentIdentifierHash?: string;
  instrumentDisplay?: string;
}

export interface ImportAdapter {
  readonly providerCode: string;
  readonly providerDisplayName: string;
  readonly parserKind: NormalizationResult["kind"];
  readonly parserVersion: string;
  readonly ownershipPolicy: "all_discovered" | "at_least_one";
  readonly minimumPostedRows?: number;
  probe(input: Buffer): ProbeResult;
  inspect(input: Buffer): { rowCount: number; identifiers: DiscoveredImportIdentifier[] };
  normalize(input: Buffer, context: OwnershipContext): NormalizationResult;
  reconcile(normalized: NormalizationResult): ReconciliationSummary;
}

export function createStatementImportAdapter<Parsed>(input: {
  providerCode: string;
  providerDisplayName: string;
  parserKind: NormalizationResult["kind"];
  parserVersion: string;
  ownershipPolicy: ImportAdapter["ownershipPolicy"];
  minimumPostedRows?: number;
  statement: StatementAdapter<Parsed>;
  discover(parsed: Parsed): Array<Omit<DiscoveredImportIdentifier, "identifierKind">>;
  identifierKind: DiscoveredImportIdentifier["identifierKind"];
}): ImportAdapter {
  return {
    providerCode: input.providerCode,
    providerDisplayName: input.providerDisplayName,
    parserKind: input.parserKind,
    parserVersion: input.parserVersion,
    ownershipPolicy: input.ownershipPolicy,
    minimumPostedRows: input.minimumPostedRows,
    probe: (bytes) => input.statement.probe(bytes),
    inspect: (bytes) => {
      const parsed = input.statement.parse(bytes);
      const normalized = input.statement.normalize(parsed, { ownership: new Map(), mappingComplete: false });
      if (normalized.kind !== input.parserKind) throw new Error("IMPORT_ADAPTER_KIND_MISMATCH");
      return {
        rowCount: normalized.rows.length,
        identifiers: input.discover(parsed).map((identifier) => ({ ...identifier, identifierKind: input.identifierKind })),
      };
    },
    normalize: (bytes, context) => {
      const normalized = input.statement.normalize(input.statement.parse(bytes), context);
      if (normalized.kind !== input.parserKind) throw new Error("IMPORT_ADAPTER_KIND_MISMATCH");
      return normalized;
    },
    reconcile: (normalized) => input.statement.reconcile(normalized),
  };
}

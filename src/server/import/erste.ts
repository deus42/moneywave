import { foreignStatementCategory } from "@/domain/foreign-statement-semantics";
import { parse } from "csv-parse/sync";
import { parseMinorUnits } from "@/domain/money";
import { hmacIdentifier, maskIdentifier } from "@/domain/privacy";
import type { NormalizationResult, NormalizedSourceRow, OwnershipContext, ProbeResult, ReconciliationSummary, StatementAdapter } from "./types";
import { parseBankDate, stableDigest } from "./workbook";

export const ERSTE_HEADERS = ["Redni broj", "Datum valute", "Datum izvršenja", "Opis plaćanja, tečaj", "Broj računa platitelja", "Isplate", "Uplate", "Stanje", "PNB platitelja", "PNB primatelja", "Platitelj/Primatelj", "Mjesto", "Referenca plaćanja"];
interface ParsedErste { accountIdentifier: string; currency: string; rows: Array<{ line: number; values: string[] }> }
function money(value: string): bigint | undefined {
  const text = value.trim();
  if (!text) return undefined;
  if (!/^-?(?:\d+|\d{1,3}(?:\.\d{3})+),\d{2}$/u.test(text)) throw new Error("ERSTE_AMOUNT_INVALID");
  return parseMinorUnits(text.replaceAll(".", ""), "EUR");
}
export class ErsteStatementAdapter implements StatementAdapter<ParsedErste> {
  constructor(private readonly options: { identifierKey: Buffer }) {}
  probe(input: Buffer): ProbeResult {
    try { this.parse(input); return { matched: true, kind: "erste_personal" }; }
    catch { return { matched: false, reasonCode: "FORMAT_UNSUPPORTED" }; }
  }
  parse(input: Buffer): ParsedErste {
    if (!input.length || input.length > 25 * 1024 * 1024) throw new Error("ERSTE_ARTIFACT_SIZE");
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(input); }
    catch { text = new TextDecoder("windows-1250", { fatal: true }).decode(input); }
    let records: Array<{ record: string[]; info: { lines: number } }>;
    try { records = parse(text, { delimiter: ";", bom: true, relax_column_count: true, info: true, max_record_size: 65536 }) as unknown as typeof records; }
    catch { throw new Error("ERSTE_CSV_INVALID"); }
    if (records.length < 3 || records.length > 100003 || JSON.stringify(records[1]?.record) !== JSON.stringify(ERSTE_HEADERS)) throw new Error("ERSTE_HEADERS_UNSUPPORTED");
    const metadata = records[0]!.record.join(" ");
    const accountIdentifier = metadata.match(/\bHR\d{19}\b/u)?.[0];
    const currency = metadata.match(/\b[Vv]alut[ai]\s+(EUR)\b/u)?.[1];
    if (!accountIdentifier || !currency) throw new Error("ERSTE_METADATA_INVALID");
    return { accountIdentifier, currency, rows: records.slice(2).filter(r => r.record.some(v => v.trim())).map(r => ({ line: r.info.lines, values: r.record })) };
  }
  discoverAccounts(parsed: ParsedErste) {
    return [{ identifierHash: hmacIdentifier(parsed.accountIdentifier, this.options.identifierKey), display: maskIdentifier(parsed.accountIdentifier), currencies: [parsed.currency] }];
  }
  normalize(parsed: ParsedErste, context: OwnershipContext): NormalizationResult {
    const ownIdentifierHash = this.discoverAccounts(parsed)[0]!.identifierHash;
    const rows = parsed.rows.map(({ line, values: v }): NormalizedSourceRow => {
      const fingerprint = stableDigest([ownIdentifierHash, ...v.slice(1)]);
      const sourceRecordId = stableDigest([line, fingerprint]);
      const base = { sourceRowNumber: line, sourceRecordId, dedupeFingerprint: fingerprint, observations: [], sourceMetadata: {} };
      try {
        if (v.length !== 13) throw new Error("ERSTE_COLUMN_COUNT");
        const occurredAt = parseBankDate(v[2]);
        const valueDate = parseBankDate(v[1]);
        if (!occurredAt || !valueDate) throw new Error("ERSTE_DATE_INVALID");
        const debit = money(v[5]!), credit = money(v[6]!), balance = money(v[7]!);
        if ((debit === undefined) === (credit === undefined) || (debit ?? credit)! < 0n || balance === undefined) throw new Error("ERSTE_AMOUNT_AMBIGUOUS");
        const amountMinor = (credit ?? 0n) - (debit ?? 0n);
        const sourceMetadata = { valueDate, balanceMinor: balance.toString(), datePrecision: "day", statementCategory: foreignStatementCategory("erste", {}, debit === undefined ? "credit" : "debit", v[3]!) };
        const target = context.ownership.get(ownIdentifierHash);
        if (!target) return { ...base, sourceMetadata, state: "unresolved", reasonCode: "OWNERSHIP_MAPPING_REQUIRED" };
        const direction = debit === undefined ? "credit" : "debit";
        return { ...base, sourceMetadata, state: "posted", direction, observations: [{
          id: stableDigest([sourceRecordId, target.accountId]), sourceRecordId, provider: "erste", accountId: target.accountId,
          ownerScope: target.ownerScope, direction, amountMinor, currency: parsed.currency, occurredAt,
          ownIdentifierHash, providerReference: v[12]!.trim() || undefined,
          description: [v[3], v[10], v[11]].filter(s => s?.trim()).join(" · "),
          resultingBalanceMinor: balance, resultingBalanceCurrency: parsed.currency,
        }] };
      } catch (error) {
        return { ...base, state: "rejected", reasonCode: error instanceof Error && /^[A-Z_]+$/u.test(error.message) ? error.message : "ERSTE_ROW_INVALID" };
      }
    });
    // A date-only export proves one end-of-day balance, never an invented time.
    const lastByDay = new Map<string, NormalizedSourceRow>();
    for (const row of rows) {
      const observation = row.observations[0];
      if (!observation) continue;
      const previous = lastByDay.get(observation.occurredAt);
      if (previous) { delete previous.observations[0]!.resultingBalanceMinor; delete previous.observations[0]!.resultingBalanceCurrency; }
      lastByDay.set(observation.occurredAt, row);
    }
    return { kind: "erste_personal", rows };
  }
  reconcile(normalized: NormalizationResult): ReconciliationSummary {
    const stateCounts = { posted: 0, non_posted: 0, unresolved: 0, rejected: 0 };
    const issues = new Set<string>();
    for (const row of normalized.rows) stateCounts[row.state]++;
    for (let i = 1; i < normalized.rows.length; i++) {
      const previous = normalized.rows[i-1]!, current = normalized.rows[i]!;
      const a = previous.observations[0], b = current.observations[0];
      if (!a || !b) continue;
      if (a.occurredAt > b.occurredAt) issues.add("ERSTE_DATE_ORDER_INVALID");
      if (BigInt(previous.sourceMetadata.balanceMinor!) + b.amountMinor !== BigInt(current.sourceMetadata.balanceMinor!)) issues.add("BALANCE_DISCONTINUITY");
    }
    return { rowCount: normalized.rows.length, coveredRowCount: normalized.rows.length, silentlySkippedRowCount: 0, stateCounts, issues: [...issues] };
  }
}

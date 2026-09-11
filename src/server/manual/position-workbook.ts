import * as XLSX from "xlsx";
import { parseMinorUnits } from "@/domain/money";
import { assertBoundedXlsx } from "./xlsx-boundary";

export const POSITION_PARSER_VERSION = "1.0.0";
export type CellDisposition = "structural" | "formula_only" | "manual_fact" | "linked_to_ledger" | "unresolved" | "rejected";
export interface ManualCell {
  sheet: string;
  address: string;
  disposition: CellDisposition;
  reason: string | null;
}
export interface ParsedPosition {
  address: string;
  label: string;
  provider: string;
  kind: "bank" | "cash";
  period: string;
  currency: "EUR" | "UAH" | "USD";
  amountMinor: string;
}
export interface PositionWorkbook { cells: ManualCell[]; positions: ParsedPosition[] }

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const HEADERS = ["erste", "revolut", "wise", "zen", "cash"];

export function monthEnd(period: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/u.test(period)) throw new Error("PERIOD_INVALID");
  return new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5)), 0)).toISOString().slice(0, 10);
}

function periodOf(cell: XLSX.CellObject | undefined): string | null {
  if (!cell || cell.f || cell.t !== "s") return null;
  const match = String(cell.v).trim().toLowerCase().match(/^([a-z]+)\s+(\d{4})$/u);
  if (!match || !MONTHS.includes(match[1]) || Number(match[2]) < 2000 || Number(match[2]) > 2200) return null;
  return `${match[2]}-${String(MONTHS.indexOf(match[1]) + 1).padStart(2, "0")}`;
}

function sourceCurrency(cell: XLSX.CellObject): ParsedPosition["currency"] | null {
  const format = String(cell.z ?? "");
  const supported = [
    ["EUR", /€|\bEUR\b/iu], ["USD", /\bUSD\b|\[\$\$[\]-]/iu], ["UAH", /₴|\bUAH\b/iu],
  ] as const;
  const matches = supported.filter(([, pattern]) => pattern.test(format));
  return matches.length === 1 ? matches[0][0] : null;
}

/** Closed, source-specific contract. No formula evaluation, data-dependent logging or network. */
export function parsePositionWorkbook(bytes: Buffer): PositionWorkbook {
  if (!bytes.length || bytes.length > 25 * 1024 * 1024) throw new Error("MANUAL_ARTIFACT_SIZE");
  assertBoundedXlsx(bytes);
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(bytes, { type: "buffer", cellFormula: true, cellNF: true, cellHTML: false, cellText: false, cellStyles: false, dense: false });
  } catch { throw new Error("MANUAL_WORKBOOK_INVALID"); }
  if (workbook.SheetNames.length > 12) throw new Error("MANUAL_SHEET_LIMIT");
  const savings = workbook.Sheets.Savings;
  if (!savings || !HEADERS.every((name, index) => {
    const cell = savings[`${String.fromCharCode(67 + index)}1`];
    // Optional source region suffix is a label, never an account identifier.
    return cell && !cell.f && new RegExp(`^${name}(?: \\([A-Z]{2}\\))?$`, "iu").test(String(cell.v).trim());
  })) throw new Error("MANUAL_HEADERS_UNSUPPORTED");

  // Iterate populated addresses, not the inflated formatted range.
  const entries = workbook.SheetNames.flatMap((sheet) => Object.entries(workbook.Sheets[sheet] ?? {})
    .filter(([address, cell]) => /^[A-Z]+[1-9]\d*$/u.test(address) && (cell.f || (cell.v !== undefined && cell.v !== null && cell.v !== "")))
    .map(([address, cell]) => ({ sheet, address, cell: cell as XLSX.CellObject })));
  if (entries.length > 50_000 || entries.some(({ address }) => {
    const coordinate = XLSX.utils.decode_cell(address);
    return coordinate.r >= 5000 || coordinate.c >= 128;
  })) throw new Error("MANUAL_CELL_LIMIT");
  const periods = new Map<number, string | null>();
  for (const { sheet, address, cell } of entries) {
    if (sheet === "Savings" && /^B[2-9]\d*$|^B1\d+$/u.test(address)) periods.set(Number(address.slice(1)), periodOf(cell));
  }
  const frequency = new Map<string, number>();
  for (const period of periods.values()) if (period) frequency.set(period, (frequency.get(period) ?? 0) + 1);
  const cells: ManualCell[] = [];
  const positions: ParsedPosition[] = [];
  for (const { sheet, address, cell } of entries) {
    const occurrence: ManualCell = { sheet, address, disposition: "structural", reason: null };
    cells.push(occurrence);
    if (cell.f) { occurrence.disposition = "formula_only"; continue; }
    if (sheet !== "Savings") { occurrence.disposition = "unresolved"; occurrence.reason = "DOMAIN_DEFERRED"; continue; }
    const coordinate = XLSX.utils.decode_cell(address);
    if (coordinate.r === 0 || coordinate.c < 2) continue;
    if (coordinate.c > 6 || !periods.has(coordinate.r + 1)) {
      occurrence.disposition = "unresolved"; occurrence.reason = "NON_POSITION_INPUT"; continue;
    }
    const period = periods.get(coordinate.r + 1);
    const currency = sourceCurrency(cell);
    const reason = !period ? "PERIOD_INVALID" : frequency.get(period)! > 1 ? "PERIOD_DUPLICATE" : !currency ? "CURRENCY_UNPROVEN" : null;
    if (reason) { occurrence.disposition = "unresolved"; occurrence.reason = reason; continue; }
    try {
      if (cell.t !== "n" || typeof cell.v !== "number" || !Number.isFinite(cell.v)) throw new Error("POSITION_VALUE_INVALID");
      // Reject unsafe numeric magnitude rather than pretending lost source digits are exact.
      if (Math.abs(cell.v) > Number.MAX_SAFE_INTEGER / 100) throw new Error("POSITION_PRECISION_UNSAFE");
      const amountMinor = parseMinorUnits(cell.v, currency!).toString();
      if (coordinate.c === 6 && BigInt(amountMinor) < 0n) throw new Error("CASH_NEGATIVE");
      positions.push({ address, label: String(savings[`${String.fromCharCode(65 + coordinate.c)}1`].v).trim(),
        provider: HEADERS[coordinate.c - 2], kind: coordinate.c === 6 ? "cash" : "bank", period: period!, currency: currency!, amountMinor });
      occurrence.disposition = "manual_fact";
    } catch (error) {
      occurrence.disposition = "rejected";
      occurrence.reason = error instanceof Error && /^[A-Z_]+$/u.test(error.message) ? error.message : "POSITION_VALUE_INVALID";
    }
  }
  return { cells, positions };
}

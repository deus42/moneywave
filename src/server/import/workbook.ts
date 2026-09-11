import { createHash } from "node:crypto";

import * as XLSX from "xlsx";

const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;
const MAX_ROWS = 100_000;
const MAX_COLUMNS = 128;

export interface WorkbookTable {
  headerRowNumber: number;
  headers: string[];
  preamble: unknown[][];
  rows: Array<{ sourceRowNumber: number; values: unknown[]; hasFormula: boolean }>;
}

function normalizedHeader(value: unknown): string {
  return String(value ?? "").normalize("NFKC").replace(/^\uFEFF/, "").trim();
}

export function readWorkbookTable(input: Buffer, requiredHeaders: readonly string[]): WorkbookTable {
  if (input.byteLength === 0) {
    throw new Error("ARTIFACT_EMPTY");
  }
  if (input.byteLength > MAX_ARTIFACT_BYTES) {
    throw new Error("ARTIFACT_TOO_LARGE");
  }

  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(input, {
      type: "buffer",
      cellFormula: true,
      cellHTML: false,
      cellNF: false,
      cellStyles: false,
      cellText: true,
      dense: false,
      WTF: false,
    });
  } catch {
    throw new Error("WORKBOOK_INVALID");
  }
  if (workbook.SheetNames.length !== 1) {
    throw new Error("WORKBOOK_SHEET_COUNT_UNSUPPORTED");
  }
  const sheet = workbook.Sheets[workbook.SheetNames[0] as string];
  if (!sheet || !sheet["!ref"]) {
    throw new Error("WORKBOOK_EMPTY_SHEET");
  }

  const range = XLSX.utils.decode_range(sheet["!ref"]);
  const rowCount = range.e.r - range.s.r + 1;
  const columnCount = range.e.c - range.s.c + 1;
  if (rowCount > MAX_ROWS || columnCount > MAX_COLUMNS) {
    throw new Error("WORKBOOK_DIMENSIONS_EXCEEDED");
  }

  const rawRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: true,
    blankrows: false,
    defval: null,
  });
  const required = new Set(requiredHeaders.map(normalizedHeader));
  const headerIndex = rawRows.findIndex((row) => {
    const values = new Set((row ?? []).map(normalizedHeader));
    return [...required].every((header) => values.has(header));
  });
  if (headerIndex < 0) {
    throw new Error("WORKBOOK_HEADERS_UNSUPPORTED");
  }
  const headers = (rawRows[headerIndex] ?? []).map(normalizedHeader);
  const formulaRows = new Set<number>();
  for (let row = range.s.r; row <= range.e.r; row += 1) {
    for (let column = range.s.c; column <= range.e.c; column += 1) {
      const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })];
      if (cell && typeof cell.f === "string") {
        formulaRows.add(row + 1);
      }
    }
  }

  const rows = rawRows
    .slice(headerIndex + 1)
    .map((values, offset) => ({
      sourceRowNumber: headerIndex + offset + 2,
      values: values ?? [],
      hasFormula: formulaRows.has(headerIndex + offset + 2),
    }))
    .filter(({ values }) => values.some((value) => value !== null && String(value).trim() !== ""));

  return { headerRowNumber: headerIndex + 1, headers, preamble: rawRows.slice(0, headerIndex), rows };
}

export function indexHeaders(headers: readonly string[]): ReadonlyMap<string, number> {
  return new Map(headers.map((header, index) => [normalizedHeader(header), index]));
}

export function cellValue(row: readonly unknown[], headerIndex: ReadonlyMap<string, number>, header: string): unknown {
  const index = headerIndex.get(normalizedHeader(header));
  return index === undefined ? null : row[index];
}

export function textValue(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).normalize("NFKC").trim();
}

export function parseBankDate(value: unknown): string | null {
  if (value === null || value === undefined || String(value).trim() === "") {
    return null;
  }
  if (typeof value === "number") {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (!parsed) {
      return null;
    }
    return `${String(parsed.y).padStart(4, "0")}-${String(parsed.m).padStart(2, "0")}-${String(parsed.d).padStart(2, "0")}T${String(parsed.H).padStart(2, "0")}:${String(parsed.M).padStart(2, "0")}:${String(Math.floor(parsed.S)).padStart(2, "0")}`;
  }
  const text = textValue(value);
  const match = text.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!match) {
    return null;
  }
  const [, day, month, year, hour = "0", minute = "0", second = "0"] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)));
  if (
    date.getUTCFullYear() !== Number(year)
    || date.getUTCMonth() !== Number(month) - 1
    || date.getUTCDate() !== Number(day)
  ) {
    return null;
  }
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T${hour.padStart(2, "0")}:${minute}:${second}`;
}

export function stableDigest(parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

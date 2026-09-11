import * as XLSX from "xlsx";

export function workbookFromRows(rows: unknown[][]): Buffer {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, sheet, "Synthetic statement");
  return Buffer.from(XLSX.write(workbook, { bookType: "xlsx", type: "buffer" }));
}

export function legacyWorkbookFromRows(rows: unknown[][]): Buffer {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, sheet, "Synthetic statement");
  return Buffer.from(XLSX.write(workbook, { bookType: "xls", type: "buffer" }));
}

export function workbookWithFormula(rows: unknown[][], cell: string, formula: string): Buffer {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet[cell] = { t: "n", v: 0, f: formula };
  XLSX.utils.book_append_sheet(workbook, sheet, "Synthetic statement");
  return Buffer.from(XLSX.write(workbook, { bookType: "xlsx", type: "buffer" }));
}

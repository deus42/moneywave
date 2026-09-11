import * as XLSX from "xlsx";

/** Entirely invented test values, not transformed personal records. */
export function syntheticManualWorkbook(options: {
  rows?: unknown[][];
  cells?: Record<string, XLSX.CellObject>;
  inflatedRange?: boolean;
} = {}): Buffer {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ["Index", "Period", "Erste", "Revolut", "Wise", "Zen", "Cash", "Total"],
    ...(options.rows ?? [[1, "January 2099", 101.25, 202, 0, null, 40], [2, "February 2099", 111, 220, 30, 5, 60]]),
  ]);
  for (const [address, cell] of Object.entries(sheet)) {
    if (/^[C-G]\d+$/u.test(address) && cell.t === "n") cell.z = '[$€]#,##0.00';
  }
  sheet.H2 = { t: "n", v: 343.25, f: "SUM(C2:G2)" };
  Object.assign(sheet, options.cells);
  if (options.inflatedRange) sheet["!ref"] = "A1:AZ2000";
  XLSX.utils.book_append_sheet(workbook, sheet, "Savings");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Synthetic planned item", 987]]), "Budget");
  return Buffer.from(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
}

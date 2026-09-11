import { randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { PrivatFopJournalAdapter } from "../src/server/import/privat-fop";
import { MonobankStatementAdapter } from "../src/server/import/monobank";
import { PrivatPersonalStatementAdapter } from "../src/server/import/privat-personal";
import type { ReconciliationSummary } from "../src/server/import/types";

function errorCode(error: unknown): string {
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(error.message)) return error.message;
  return "REAL_DATA_VERIFICATION_FAILED";
}

function assertCompleteCoverage(reconciliation: ReconciliationSummary): void {
  const partitionedRows = Object.values(reconciliation.stateCounts).reduce((sum, count) => sum + count, 0);
  if (
    reconciliation.coveredRowCount !== reconciliation.rowCount
    || reconciliation.silentlySkippedRowCount !== 0
    || partitionedRows !== reconciliation.rowCount
  ) {
    throw new Error("IMPORT_ROW_COVERAGE_FAILED");
  }
}

const inputs = (await Promise.all(["privatebank", "monobank"].map(async (providerDirectory) => {
  const inbox = join(process.cwd(), "data", providerDirectory);
  const entries = await readdir(inbox, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && !entry.name.startsWith("~$") && /\.(?:csv|xls|xlsx)$/iu.test(entry.name))
    .map((entry) => join(inbox, entry.name));
}))).flat().sort();

if (inputs.length === 0) {
  process.stdout.write("sample_0 FAIL REAL_DATA_INPUT_MISSING\n");
  process.exitCode = 1;
} else {
  let failed = false;
  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = () => undefined;
  console.error = () => undefined;
  for (const [index, path] of inputs.entries()) {
    const key = randomBytes(32);
    let bytes: Buffer | undefined;
    try {
      bytes = await readFile(path);
      const personal = new PrivatPersonalStatementAdapter({ identifierKey: key });
      const fop = new PrivatFopJournalAdapter({ identifierKey: key });
      const monobank = new MonobankStatementAdapter({ identifierKey: key });
      const matches = [personal.probe(bytes).matched, fop.probe(bytes).matched, monobank.probe(bytes).matched];
      if (matches.filter(Boolean).length !== 1) throw new Error("REAL_DATA_FORMAT_AMBIGUOUS");
      if (matches[0]) {
        const parsed = personal.parse(bytes);
        const instruments = personal.discoverInstruments(parsed);
        if (parsed.rows.length === 0 || instruments.length === 0) throw new Error("REAL_DATA_ROWS_EMPTY");
        const ownership = new Map(instruments.map((instrument, instrumentIndex) => [
          instrument.identifierHash,
          {
            accountId: `acceptance-account-${instrumentIndex + 1}`,
            instrumentId: `acceptance-instrument-${instrumentIndex + 1}`,
            ownerScope: "PERSONAL" as const,
          },
        ]));
        const normalized = personal.normalize(parsed, { ownership, mappingComplete: true });
        const reconciliation = personal.reconcile(normalized);
        assertCompleteCoverage(reconciliation);
      } else if (matches[1]) {
        const parsed = fop.parse(bytes);
        if (parsed.rows.length === 0 || fop.discoverAccounts(parsed).length === 0) throw new Error("REAL_DATA_ROWS_EMPTY");
        const normalized = fop.normalize(parsed, { ownership: new Map(), mappingComplete: true });
        const reconciliation = fop.reconcile(normalized);
        assertCompleteCoverage(reconciliation);
      } else {
        const parsed = monobank.parse(bytes);
        const accounts = monobank.discoverAccounts(parsed);
        if (parsed.rows.length === 0 || accounts.length === 0) throw new Error("REAL_DATA_ROWS_EMPTY");
        const ownership = new Map(accounts.map((account, accountIndex) => [
          account.identifierHash,
          {
            accountId: `acceptance-monobank-account-${accountIndex + 1}`,
            instrumentId: `acceptance-monobank-instrument-${accountIndex + 1}`,
            instrumentIdentifierHash: account.instrumentIdentifierHash,
            ownerScope: "PERSONAL" as const,
          },
        ]));
        const normalized = monobank.normalize(parsed, { ownership, mappingComplete: true });
        const reconciliation = monobank.reconcile(normalized);
        assertCompleteCoverage(reconciliation);
        if (reconciliation.stateCounts.posted === 0) throw new Error("IMPORT_POSTED_ROWS_EMPTY");
        if (reconciliation.stateCounts.rejected !== 0) throw new Error("IMPORT_REJECTED_ROWS_PRESENT");
      }
      process.stdout.write(`sample_${index + 1} PASS\n`);
    } catch (error) {
      failed = true;
      process.stdout.write(`sample_${index + 1} FAIL ${errorCode(error)}\n`);
    } finally {
      bytes?.fill(0);
      key.fill(0);
    }
  }
  console.warn = originalWarn;
  console.error = originalError;
  if (failed) process.exitCode = 1;
}

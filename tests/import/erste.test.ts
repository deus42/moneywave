import { describe, expect, it } from "vitest";
import { ErsteStatementAdapter, ERSTE_HEADERS } from "../../src/server/import/erste";
const key = Buffer.alloc(32, 7);
function fixture(second = "80,00") {
  return Buffer.from([
    " Promet po racunu HR1210010051863000160 Valuta EUR",
    ERSTE_HEADERS.join(";"), " ",
    '1;01.01.2025;01.01.2025;Synthetic deposit;; ;100,00;100,00;;;;;SYNTH-1',
    `2;01.01.2025;01.01.2025;Synthetic shop;;20,00; ;${second};;;;;SYNTH-2`,
  ].join("\r\n"));
}
function normalized(bytes = fixture()) {
  const adapter = new ErsteStatementAdapter({ identifierKey: key });
  const parsed = adapter.parse(bytes);
  const account = adapter.discoverAccounts(parsed)[0]!;
  return { adapter, result: adapter.normalize(parsed, { mappingComplete: true, ownership: new Map([[account.identifierHash, { accountId: "synthetic-account", ownerScope: "PERSONAL" }]]) }) };
}
describe("Erste CSV", () => {
  it("preserves every row, signs debits and records only the daily closing balance", () => {
    const { adapter, result } = normalized();
    expect(result.rows.map(r => r.state)).toEqual(["posted", "posted"]);
    expect(result.rows.map(r => r.observations[0]!.amountMinor)).toEqual([10000n, -2000n]);
    expect(result.rows.map(r => r.observations[0]!.resultingBalanceMinor)).toEqual([undefined, 8000n]);
    expect(adapter.reconcile(result).issues).toEqual([]);
  });
  it("reports a discontinuity even within the same day", () => {
    const { adapter, result } = normalized(fixture("79,00"));
    expect(adapter.reconcile(result).issues).toContain("BALANCE_DISCONTINUITY");
  });
  it("requires ownership and rejects malformed amounts without dropping rows", () => {
    const adapter = new ErsteStatementAdapter({ identifierKey: key });
    expect(adapter.normalize(adapter.parse(fixture()), { mappingComplete: false, ownership: new Map() }).rows.every(r => r.state === "unresolved")).toBe(true);
    expect(normalized(Buffer.from(fixture().toString().replace("20,00", "2.0,00"))).result.rows[1]!.state).toBe("rejected");
  });
  it("keeps source identity stable when an export sequence changes", () => {
    expect(normalized().result.rows[0]!.dedupeFingerprint).toBe(normalized(Buffer.from(fixture().toString().replace('1;01.', '8;01.'))).result.rows[0]!.dedupeFingerprint);
  });
  it("rejects invalid dates and unknown formats", () => {
    expect(normalized(Buffer.from(fixture().toString().replaceAll('01.01.2025', '31.02.2025'))).result.rows.every(r => r.state === 'rejected')).toBe(true);
    expect(new ErsteStatementAdapter({identifierKey:key}).probe(Buffer.from('garbage')).matched).toBe(false);
  });
});

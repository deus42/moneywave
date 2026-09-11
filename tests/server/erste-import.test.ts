import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openEncryptedDatabase } from "../../src/server/db/database";
import { applyMigrations } from "../../src/server/db/migrations";
import { ImportRepository } from "../../src/server/import/repository";
import { ErsteStatementAdapter, ERSTE_HEADERS } from "../../src/server/import/erste";
it("stores immutable Erste evidence and merges overlapping exports without duplicate entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "synthetic-erste-"));
  const db = await openEncryptedDatabase(join(dir, "test.db"), Buffer.alloc(32, 2));
  try {
    await applyMigrations(db);
    await db.run("INSERT INTO manual_workbooks (id,contract_version) VALUES ('synthetic-workbook','synthetic')");
    await db.run("INSERT INTO manual_position_series (id,lineage_id,label_key,display_name,provider_code,position_kind,currency) VALUES ('synthetic-series','synthetic-workbook',?,'Synthetic Erste','erste','bank','EUR')", ['b'.repeat(64)]);
    const adapter = new ErsteStatementAdapter({ identifierKey: Buffer.alloc(32, 3) });
    const bytes = Buffer.from(`Synthetic HR1210010051863000160 Valuta EUR\n${ERSTE_HEADERS.join(';')}\n \n1;02.01.2025;02.01.2025;Synthetic deposit;;;50,00;50,00;;;;;SYNTH-REF`);
    const identifier = adapter.discoverAccounts(adapter.parse(bytes))[0]!;
    const context = { mappingComplete: true, ownership: new Map([[identifier.identifierHash, { accountId: 'synthetic-erste', ownerScope: 'PERSONAL' as const }]]) };
    const repository = new ImportRepository(db);
    const rejectedBytes=Buffer.from(bytes.toString().replace('SYNTH-REF','SYNTH-INVALID-BINDING'));
    await expect(repository.commitImport({
      artifact:{bytes:rejectedBytes,sha256:createHash('sha256').update(rejectedBytes).digest('hex'),parserKind:'erste_personal',parserVersion:'erste-personal@1'},
      normalization:adapter.normalize(adapter.parse(rejectedBytes),context),provider:{code:'erste',displayName:'Erste'},
      registrations:[{manualPositionSeriesId:'missing-series',accountId:'synthetic-erste',displayName:'Synthetic Erste',ownerScope:'PERSONAL',accountType:'bank',currency:'EUR',identifierHash:identifier.identifierHash,identifierKind:'account',maskedDisplay:identifier.display}],
    })).rejects.toThrow('MANUAL_ACCOUNT_BINDING_CONFLICT');
    expect(await db.get('SELECT COUNT(*) AS n FROM accounts')).toEqual({n:0});
    expect(await db.get('SELECT COUNT(*) AS n FROM import_artifacts')).toEqual({n:0});

    for (const [i, input] of [bytes, Buffer.from(bytes.toString().replace('1;02.', '2;02.'))].entries()) {
      const result = await repository.commitImport({
        artifact: { bytes: input, sha256: createHash('sha256').update(input).digest('hex'), parserKind: 'erste_personal', parserVersion: 'erste-personal@1' },
        normalization: adapter.normalize(adapter.parse(input), context), provider: { code: 'erste', displayName: 'Erste' },
        registrations: [{ manualPositionSeriesId: 'synthetic-series', accountId: 'synthetic-erste', displayName: 'Synthetic Erste', ownerScope: 'PERSONAL', accountType: 'bank', currency: 'EUR', identifierHash: identifier.identifierHash, identifierKind: 'account', maskedDisplay: identifier.display }],
      });
      expect(result.canonicalEntriesCreated).toBe(i === 0 ? 1 : 0);
      expect(result.conflictsCreated).toBe(0);
    }
    expect(await db.get("SELECT account_id AS account FROM manual_position_series WHERE id='synthetic-series'")).toEqual({account:'synthetic-erste'});
    expect(await db.get('SELECT COUNT(*) AS n FROM ledger_entries')).toEqual({ n: 1 });
    expect(await db.get('SELECT COUNT(*) AS n FROM source_records')).toEqual({ n: 2 });
    const artifact = await db.get<{ bytes: Buffer }>('SELECT encrypted_bytes AS bytes FROM import_artifacts ORDER BY rowid LIMIT 1');
    expect(artifact!.bytes.equals(bytes)).toBe(true);
    expect(await db.all('PRAGMA foreign_key_check')).toEqual([]);
  } finally { await db.close(); await rm(dir, { recursive: true, force: true }); }
});

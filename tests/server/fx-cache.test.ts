import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openEncryptedDatabase, type EncryptedDatabase } from "@/server/db/database";
import { applyMigrations } from "@/server/db/migrations";
import { DatabaseFxRateCache } from "@/server/fx/database-cache";

describe("encrypted official FX cache", () => {
  let directory: string;
  let database: EncryptedDatabase;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "moneywave-fx-cache-"));
    database = await openEncryptedDatabase(join(directory, "moneywave.db"), Buffer.alloc(32, 71));
    await applyMigrations(database);
  });

  afterEach(async () => {
    await database.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });

  it("persists decimal text, source, and publication date by requested pair/date", async () => {
    const cache = new DatabaseFxRateCache(database);
    await cache.set("USD", "UAH", "2099-01-03", { rate: "40.50", source: "ECB", publicationDate: "2099-01-02" });
    expect(await cache.get("USD", "UAH", "2099-01-03")).toEqual({ rate: "40.50", source: "ECB", publicationDate: "2099-01-02" });
    expect(await cache.get("USD", "UAH", "2099-01-04")).toBeNull();
  });
});

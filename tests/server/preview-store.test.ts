import { access, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SecurePreviewStore } from "@/server/import/preview-store";

describe("secure import preview storage", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "moneywave-preview-test-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("writes a 0600 temporary artifact, verifies its hash, and removes it after consumption", async () => {
    const store = new SecurePreviewStore(directory);
    const bytes = Buffer.from("SYNTHETIC-STATEMENT-CONTENT", "utf8");
    const preview = await store.put(bytes, { parserKind: "monobank_personal" });
    expect(preview.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect((await stat(preview.path)).mode & 0o777).toBe(0o600);
    expect(await store.read(preview.id)).toEqual(bytes);

    await store.delete(preview.id);
    await expect(access(preview.path)).rejects.toThrow();
    await expect(store.read(preview.id)).rejects.toThrow("IMPORT_PREVIEW_NOT_FOUND");
  });

  it("refuses a modified temporary artifact", async () => {
    const store = new SecurePreviewStore(directory);
    const preview = await store.put(Buffer.from("SYNTHETIC-ORIGINAL", "utf8"), { parserKind: "monobank_personal" });
    await import("node:fs/promises").then(({ writeFile }) => writeFile(preview.path, "SYNTHETIC-MODIFIED", { mode: 0o600 }));
    await expect(store.read(preview.id)).rejects.toThrow("IMPORT_PREVIEW_HASH_MISMATCH");
  });

  it("removes orphaned plaintext previews before accepting a new artifact", async () => {
    const orphanPath = join(directory, "orphan.preview");
    await writeFile(orphanPath, "SYNTHETIC-ORPHAN", { mode: 0o600 });

    const store = new SecurePreviewStore(directory);
    await store.put(Buffer.from("SYNTHETIC-NEW", "utf8"), { parserKind: "monobank_personal" });

    await expect(access(orphanPath)).rejects.toThrow();
  });
});

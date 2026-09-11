import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import type { NormalizationResult } from "./types";

interface PreviewEntry {
  id: string;
  path: string;
  sha256: string;
  parserKind: NormalizationResult["kind"];
  expiresAt: number;
}

const PREVIEW_TTL_MS = 30 * 60 * 1000;

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export class SecurePreviewStore {
  readonly #directory: string;
  readonly #entries = new Map<string, PreviewEntry>();
  #initialization?: Promise<void>;

  constructor(directory: string) {
    this.#directory = directory;
  }

  async put(bytes: Buffer, metadata: { parserKind: NormalizationResult["kind"] }): Promise<PreviewEntry> {
    if (bytes.byteLength === 0) throw new Error("IMPORT_ARTIFACT_EMPTY");
    await this.#initialize();
    await this.cleanupExpired();
    const id = randomUUID();
    const path = join(this.#directory, `${id}.preview`);
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(path, 0o600);
    const entry = { id, path, sha256: digest(bytes), parserKind: metadata.parserKind, expiresAt: Date.now() + PREVIEW_TTL_MS };
    this.#entries.set(id, entry);
    return entry;
  }

  async read(id: string): Promise<Buffer> {
    const entry = this.#entries.get(id);
    if (!entry || entry.expiresAt <= Date.now()) {
      if (entry) await this.delete(id);
      throw new Error("IMPORT_PREVIEW_NOT_FOUND");
    }
    const bytes = await readFile(entry.path).catch(() => null);
    if (!bytes) {
      this.#entries.delete(id);
      throw new Error("IMPORT_PREVIEW_NOT_FOUND");
    }
    const expected = Buffer.from(entry.sha256, "hex");
    const actual = Buffer.from(digest(bytes), "hex");
    if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
      await this.delete(id);
      throw new Error("IMPORT_PREVIEW_HASH_MISMATCH");
    }
    return bytes;
  }

  get(id: string): Omit<PreviewEntry, "path"> | null {
    const entry = this.#entries.get(id);
    if (!entry || entry.expiresAt <= Date.now()) return null;
    return {
      id: entry.id,
      sha256: entry.sha256,
      parserKind: entry.parserKind,
      expiresAt: entry.expiresAt,
    };
  }

  async delete(id: string): Promise<void> {
    const entry = this.#entries.get(id);
    this.#entries.delete(id);
    if (entry) await rm(entry.path, { force: true });
  }

  async cleanupExpired(): Promise<void> {
    const now = Date.now();
    await Promise.all([...this.#entries.values()].filter(({ expiresAt }) => expiresAt <= now).map(({ id }) => this.delete(id)));
  }

  #initialize(): Promise<void> {
    this.#initialization ??= (async () => {
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      await chmod(this.#directory, 0o700);
      const entries = await readdir(this.#directory, { withFileTypes: true });
      await Promise.all(entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".preview"))
        .map((entry) => rm(join(this.#directory, entry.name), { force: true })));
    })();
    return this.#initialization;
  }
}

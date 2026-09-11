import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildKeychainHelper } from "@/server/secrets/build-keychain-helper";
import { MacKeychainStore } from "@/server/secrets/keychain-store";
import { deriveIdentifierHmacKey } from "@/server/secrets/key-derivation";
import { decodeRecoveryKey, RecoverySetup } from "@/server/secrets/recovery-setup";

const darwinDescribe = process.platform === "darwin" ? describe : describe.skip;

darwinDescribe("macOS Keychain helper", () => {
  let directory = "";
  let helperPath = "";

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "moneywave-keychain-test-"));
    helperPath = join(directory, "moneywave-keychain");
    await buildKeychainHelper(helperPath);
  }, 30_000);

  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("sets, reads, updates, and deletes a non-synchronizing generic password", async () => {
    const service = `app.moneywave.synthetic.${randomUUID()}`;
    const store = new MacKeychainStore({ helperPath, service });
    const account = "synthetic-item";
    try {
      await store.set(account, Buffer.from("SYNTHETIC-SECRET-ONE", "utf8"));
      expect((await store.get(account)).toString("utf8")).toBe("SYNTHETIC-SECRET-ONE");
      await store.set(account, Buffer.from("SYNTHETIC-SECRET-TWO", "utf8"));
      expect((await store.get(account)).toString("utf8")).toBe("SYNTHETIC-SECRET-TWO");
      expect(await store.has(account)).toBe(true);
    } finally {
      await store.delete(account);
    }
    expect(await store.has(account)).toBe(false);
    await expect(store.get(account)).rejects.toThrow("KEYCHAIN_ITEM_NOT_FOUND");
  });

  it("generates a 256-bit one-time recovery key and persists it only after exact confirmation", async () => {
    const service = `app.moneywave.synthetic.${randomUUID()}`;
    const store = new MacKeychainStore({ helperPath, service });
    const setup = new RecoverySetup(store);
    try {
      const pending = setup.begin();
      expect(pending.recoveryKey).toMatch(/^MW1-[A-Za-z0-9_-]{43}$/);
      await expect(setup.confirm(pending.setupId, "MW1-WRONG-SYNTHETIC-CONFIRMATION")).rejects.toThrow("RECOVERY_CONFIRMATION_MISMATCH");
      expect(await store.has("database-key")).toBe(false);

      await setup.confirm(pending.setupId, pending.recoveryKey);
      const databaseKey = await store.get("database-key");
      const recoveredKey = decodeRecoveryKey(pending.recoveryKey);
      const identifierKey = deriveIdentifierHmacKey(databaseKey);
      const recoveredIdentifierKey = deriveIdentifierHmacKey(recoveredKey);
      expect(databaseKey).toHaveLength(32);
      expect(identifierKey.equals(recoveredIdentifierKey)).toBe(true);
      expect(await store.has("identifier-hmac-key")).toBe(false);
      databaseKey.fill(0);
      recoveredKey.fill(0);
      identifierKey.fill(0);
      recoveredIdentifierKey.fill(0);
      await expect(setup.confirm(pending.setupId, pending.recoveryKey)).rejects.toThrow("RECOVERY_SETUP_NOT_PENDING");
    } finally {
      await store.delete("database-key");
      await store.delete("identifier-hmac-key");
    }
  });
});

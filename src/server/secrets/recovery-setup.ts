import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import type { SecretStore } from "./keychain-store";

interface PendingSetup {
  key: Buffer;
  expiresAt: number;
}

const PREFIX = "MW1-";
const PENDING_TTL_MS = 10 * 60 * 1000;

export function decodeRecoveryKey(recoveryKey: string): Buffer {
  if (!/^MW1-[A-Za-z0-9_-]{43}$/.test(recoveryKey)) throw new Error("RECOVERY_KEY_INVALID");
  const decoded = Buffer.from(recoveryKey.slice(PREFIX.length), "base64url");
  if (decoded.byteLength !== 32) throw new Error("RECOVERY_KEY_INVALID");
  return decoded;
}

export class RecoverySetup {
  readonly #store: SecretStore;
  readonly #pending = new Map<string, PendingSetup>();

  constructor(store: SecretStore) {
    this.#store = store;
  }

  begin(): { setupId: string; recoveryKey: string } {
    this.#purgeExpired();
    const setupId = randomUUID();
    const key = randomBytes(32);
    this.#pending.set(setupId, { key, expiresAt: Date.now() + PENDING_TTL_MS });
    return { setupId, recoveryKey: `${PREFIX}${key.toString("base64url")}` };
  }

  async confirm(setupId: string, confirmation: string): Promise<void> {
    this.#purgeExpired();
    const pending = this.#pending.get(setupId);
    if (!pending) throw new Error("RECOVERY_SETUP_NOT_PENDING");
    let confirmed: Buffer;
    try {
      confirmed = decodeRecoveryKey(confirmation);
    } catch {
      throw new Error("RECOVERY_CONFIRMATION_MISMATCH");
    }
    if (!timingSafeEqual(pending.key, confirmed)) {
      confirmed.fill(0);
      throw new Error("RECOVERY_CONFIRMATION_MISMATCH");
    }
    confirmed.fill(0);

    try {
      await this.#store.set("database-key", pending.key);
    } catch {
      throw new Error("RECOVERY_SETUP_PERSIST_FAILED");
    }
    pending.key.fill(0);
    this.#pending.delete(setupId);
  }

  #purgeExpired(): void {
    const now = Date.now();
    for (const [id, pending] of this.#pending) {
      if (pending.expiresAt > now) continue;
      pending.key.fill(0);
      this.#pending.delete(id);
    }
  }
}

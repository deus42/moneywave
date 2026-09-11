import { createHmac } from "node:crypto";

export function normalizeIdentifier(value: string): string {
  return value.normalize("NFKC").trim().toUpperCase().replace(/[^\p{L}\p{N}]/gu, "");
}

export function hmacIdentifier(value: string, key: Buffer): string {
  if (key.byteLength !== 32) {
    throw new Error("IDENTIFIER_KEY_INVALID");
  }
  const normalized = normalizeIdentifier(value);
  if (!normalized) {
    throw new Error("IDENTIFIER_REQUIRED");
  }
  return createHmac("sha256", key).update(normalized, "utf8").digest("hex");
}

export function maskIdentifier(value: string): string {
  const normalized = normalizeIdentifier(value);
  if (normalized.length < 4) {
    return "••••";
  }
  return `•••• ${normalized.slice(-4)}`;
}

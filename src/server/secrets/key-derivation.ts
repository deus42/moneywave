import { hkdfSync } from "node:crypto";

const IDENTIFIER_HMAC_CONTEXT = Buffer.from("moneywave:identifier-hmac:v1", "utf8");

export function deriveIdentifierHmacKey(databaseKey: Buffer): Buffer {
  if (databaseKey.byteLength !== 32) throw new Error("DB_KEY_INVALID");
  return Buffer.from(hkdfSync("sha256", databaseKey, Buffer.alloc(0), IDENTIFIER_HMAC_CONTEXT, 32));
}

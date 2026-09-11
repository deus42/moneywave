import { spawn } from "node:child_process";

const MAX_SECRET_BYTES = 65_536;

interface HelperResult {
  code: number;
  stdout: Buffer;
}

function runHelper(helperPath: string, args: readonly string[], input?: Buffer): Promise<HelperResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(helperPath, [...args], { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    let stdoutLength = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutLength += chunk.byteLength;
      if (stdoutLength <= MAX_SECRET_BYTES) stdout.push(Buffer.from(chunk));
    });
    child.stderr.resume();
    child.once("error", () => reject(new Error("KEYCHAIN_HELPER_START_FAILED")));
    child.once("close", (code) => resolve({ code: code ?? 42, stdout: Buffer.concat(stdout) }));
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

function validateToken(value: string): void {
  if (!/^[A-Za-z0-9._:-]{1,180}$/.test(value)) throw new Error("KEYCHAIN_IDENTIFIER_INVALID");
}

export interface SecretStore {
  set(account: string, secret: Buffer): Promise<void>;
  get(account: string): Promise<Buffer>;
  has(account: string): Promise<boolean>;
  delete(account: string): Promise<void>;
}

export class MacKeychainStore implements SecretStore {
  readonly #helperPath: string;
  readonly #service: string;

  constructor({ helperPath, service = "app.moneywave.local" }: { helperPath: string; service?: string }) {
    validateToken(service);
    this.#helperPath = helperPath;
    this.#service = service;
  }

  async set(account: string, secret: Buffer): Promise<void> {
    validateToken(account);
    if (secret.byteLength === 0 || secret.byteLength > MAX_SECRET_BYTES) throw new Error("KEYCHAIN_SECRET_INVALID");
    const result = await runHelper(this.#helperPath, ["set", this.#service, account], secret);
    if (result.code !== 0) throw new Error("KEYCHAIN_WRITE_FAILED");
  }

  async get(account: string): Promise<Buffer> {
    validateToken(account);
    const result = await runHelper(this.#helperPath, ["get", this.#service, account]);
    if (result.code === 44) throw new Error("KEYCHAIN_ITEM_NOT_FOUND");
    if (result.code !== 0 || result.stdout.byteLength === 0 || result.stdout.byteLength > MAX_SECRET_BYTES) {
      throw new Error("KEYCHAIN_READ_FAILED");
    }
    return result.stdout;
  }

  async has(account: string): Promise<boolean> {
    validateToken(account);
    const result = await runHelper(this.#helperPath, ["has", this.#service, account]);
    if (result.code === 44) return false;
    if (result.code !== 0) throw new Error("KEYCHAIN_READ_FAILED");
    return true;
  }

  async delete(account: string): Promise<void> {
    validateToken(account);
    const result = await runHelper(this.#helperPath, ["delete", this.#service, account]);
    if (result.code !== 0) throw new Error("KEYCHAIN_DELETE_FAILED");
  }
}

import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import sqlite3 from "@journeyapps/sqlcipher";

export type SqlParameter = string | number | Buffer | null;

export interface RunResult {
  lastId: number;
  changes: number;
}

export interface EncryptedDatabase {
  readonly path:string;
  run(sql:string,parameters?:readonly SqlParameter[]):Promise<RunResult>;
  get<T>(sql:string,parameters?:readonly SqlParameter[]):Promise<T|undefined>;
  all<T>(sql:string,parameters?:readonly SqlParameter[]):Promise<T[]>;
  exec(sql:string):Promise<void>;
  transaction<T>(operation:()=>Promise<T>):Promise<T>;
  close():Promise<void>;
}

class LocalEncryptedDatabase implements EncryptedDatabase {
  readonly path: string;
  readonly #raw: sqlite3.Database;
  #closed = false;

  constructor(path: string, raw: sqlite3.Database) {
    this.path = path;
    this.#raw = raw;
  }

  run(sql: string, parameters: readonly SqlParameter[] = []): Promise<RunResult> {
    if (this.#closed) return Promise.reject(new Error("DB_CLOSED"));
    return new Promise((resolve, reject) => {
      this.#raw.run(sql, [...parameters], function callback(error) {
        if (error) reject(error);
        else resolve({ lastId: this.lastID, changes: this.changes });
      });
    });
  }

  get<T>(sql: string, parameters: readonly SqlParameter[] = []): Promise<T | undefined> {
    if (this.#closed) return Promise.reject(new Error("DB_CLOSED"));
    return new Promise((resolve, reject) => {
      this.#raw.get(sql, [...parameters], (error, row) => {
        if (error) reject(error);
        else resolve(row as T | undefined);
      });
    });
  }

  all<T>(sql: string, parameters: readonly SqlParameter[] = []): Promise<T[]> {
    if (this.#closed) return Promise.reject(new Error("DB_CLOSED"));
    return new Promise((resolve, reject) => {
      this.#raw.all(sql, [...parameters], (error, rows) => {
        if (error) reject(error);
        else resolve(rows as T[]);
      });
    });
  }

  exec(sql: string): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("DB_CLOSED"));
    return new Promise((resolve, reject) => {
      this.#raw.exec(sql, (error) => error ? reject(error) : resolve());
    });
  }

  async transaction<T>(operation: () => Promise<T>): Promise<T> {
    await this.exec("BEGIN IMMEDIATE");
    try {
      const result = await operation();
      await this.exec("COMMIT");
      return result;
    } catch (error) {
      await this.exec("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }

  close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.#raw.close((error) => {
        if (error) reject(error);
        else {
          this.#closed = true;
          resolve();
        }
      });
    });
  }
}

function openNative(path: string): Promise<sqlite3.Database> {
  return new Promise((resolve, reject) => {
    const database = new sqlite3.Database(path, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (error) => {
      if (error) reject(error);
      else resolve(database);
    });
  });
}

export async function openEncryptedDatabase(path: string, key: Buffer): Promise<EncryptedDatabase> {
  if (key.byteLength !== 32) throw new Error("DB_KEY_INVALID");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const raw = await openNative(path);
  const database = new LocalEncryptedDatabase(path, raw);
  try {
    await database.exec(`PRAGMA key = "x'${key.toString("hex")}'"`);
    await database.get("SELECT count(*) AS count FROM sqlite_master");
    const cipher = await database.get<{ cipher_version?: string }>("PRAGMA cipher_version");
    if (!cipher?.cipher_version) throw new Error("DB_CIPHER_UNAVAILABLE");
    await database.exec("PRAGMA cipher_memory_security = ON; PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 5000");
    await chmod(path, 0o600);
    return database;
  } catch {
    await database.close().catch(() => undefined);
    throw new Error("DB_KEY_REJECTED");
  }
}

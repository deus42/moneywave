import type { FxRateCache, OfficialFxRate } from "@/domain/fx-service";
import type { EncryptedDatabase } from "@/server/db/database";

export class DatabaseFxRateCache implements FxRateCache {
  readonly #database: EncryptedDatabase;

  constructor(database: EncryptedDatabase) {
    this.#database = database;
  }

  async get(base: string, quote: string, onOrBeforeDate: string): Promise<OfficialFxRate | null> {
    const row = await this.#database.get<{
      rate: string;
      source: "ECB" | "NBU";
      publicationDate: string;
    }>(
      "SELECT rate_text AS rate, source, publication_date AS publicationDate FROM fx_rate_cache WHERE base_currency = ? AND quote_currency = ? AND requested_date = ?",
      [base, quote, onOrBeforeDate],
    );
    return row ?? null;
  }

  async set(base: string, quote: string, onOrBeforeDate: string, rate: OfficialFxRate): Promise<void> {
    await this.#database.run(
      `INSERT INTO fx_rate_cache (base_currency, quote_currency, requested_date, rate_text, source, publication_date)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(base_currency, quote_currency, requested_date) DO UPDATE SET
         rate_text = excluded.rate_text,
         source = excluded.source,
         publication_date = excluded.publication_date,
         cached_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      [base, quote, onOrBeforeDate, rate.rate, rate.source, rate.publicationDate],
    );
  }
}

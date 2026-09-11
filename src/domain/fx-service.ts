import Decimal from "decimal.js";

export interface OfficialFxRate {
  rate: string;
  publicationDate: string;
  source: "ECB" | "NBU";
}

export interface OfficialRateProvider {
  name: "ECB" | "NBU";
  getRate(base: string, quote: string, onOrBeforeDate: string): Promise<OfficialFxRate | null>;
}

export interface FxRateCache {
  get(base: string, quote: string, onOrBeforeDate: string): Promise<OfficialFxRate | null>;
  set(base: string, quote: string, onOrBeforeDate: string, rate: OfficialFxRate): Promise<void>;
}

function normalizedRate(rate: string): string {
  let decimal: Decimal;
  try {
    decimal = new Decimal(rate);
  } catch {
    throw new Error("FX_RATE_INVALID");
  }
  if (!decimal.isFinite() || decimal.lte(0)) throw new Error("FX_RATE_INVALID");
  return decimal.toSignificantDigits(20).toString();
}

function validatePair(base: string, quote: string, date: string): [string, string] {
  const normalizedBase = base.trim().toUpperCase();
  const normalizedQuote = quote.trim().toUpperCase();
  if (!/^[A-Z]{3,8}$/.test(normalizedBase) || !/^[A-Z]{3,8}$/.test(normalizedQuote)) throw new Error("FX_PAIR_INVALID");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("FX_DATE_INVALID");
  return [normalizedBase, normalizedQuote];
}

export class InMemoryFxRateCache implements FxRateCache {
  readonly #rates = new Map<string, OfficialFxRate>();

  async get(base: string, quote: string, onOrBeforeDate: string): Promise<OfficialFxRate | null> {
    return this.#rates.get(`${base}:${quote}:${onOrBeforeDate}`) ?? null;
  }

  async set(base: string, quote: string, onOrBeforeDate: string, rate: OfficialFxRate): Promise<void> {
    this.#rates.set(`${base}:${quote}:${onOrBeforeDate}`, rate);
  }
}

export class FxService {
  readonly #ecb: OfficialRateProvider;
  readonly #nbu: OfficialRateProvider;
  readonly #cache: FxRateCache;

  constructor(input: { ecb: OfficialRateProvider; nbu: OfficialRateProvider; cache: FxRateCache }) {
    this.#ecb = input.ecb;
    this.#nbu = input.nbu;
    this.#cache = input.cache;
  }

  async resolve(input: {
    base: string;
    quote: string;
    onOrBeforeDate: string;
    transactionRate?: string | null;
  }): Promise<OfficialFxRate | { rate: string; source: "transaction"; publicationDate: string }> {
    validatePair(input.base, input.quote, input.onOrBeforeDate);
    if (input.transactionRate) {
      return { rate: normalizedRate(input.transactionRate), source: "transaction", publicationDate: input.onOrBeforeDate };
    }
    return this.benchmark(input);
  }

  async benchmark(input: { base: string; quote: string; onOrBeforeDate: string }): Promise<OfficialFxRate> {
    const [base, quote] = validatePair(input.base, input.quote, input.onOrBeforeDate);
    const cached = await this.#cache.get(base, quote, input.onOrBeforeDate);
    if (cached) return cached;
    for (const provider of [this.#ecb, this.#nbu]) {
      const rate = await provider.getRate(base, quote, input.onOrBeforeDate);
      if (!rate) continue;
      const normalized = { ...rate, rate: normalizedRate(rate.rate) };
      await this.#cache.set(base, quote, input.onOrBeforeDate, normalized);
      return normalized;
    }
    throw new Error("FX_RATE_UNAVAILABLE");
  }
}

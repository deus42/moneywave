import Decimal from "decimal.js";
import { parse } from "csv-parse/sync";

import type { OfficialFxRate, OfficialRateProvider } from "@/domain/fx-service";
import { guardedFetch } from "@/server/security/boundary";
import type { HistoricalRateEdge, HistoricalRateLoader, HistoricalRateLoadInput } from "./historical-rates";

type FetchImplementation = (input: string | URL, init?: RequestInit) => Promise<Response>;

function subtractDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new Error("FX_DATE_INVALID");
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function normalizeOfficialRate(value: unknown): string | null {
  try {
    const decimal = new Decimal(String(value));
    return decimal.isFinite() && decimal.gt(0) ? decimal.toSignificantDigits(20).toString() : null;
  } catch {
    return null;
  }
}

export class EcbRateProvider implements OfficialRateProvider {
  readonly name = "ECB" as const;
  readonly #fetch: FetchImplementation;

  constructor({ fetchImpl = guardedFetch }: { fetchImpl?: FetchImplementation } = {}) {
    this.#fetch = fetchImpl;
  }

  async getRate(base: string, quote: string, onOrBeforeDate: string): Promise<OfficialFxRate | null> {
    if (base === quote) return { rate: "1", publicationDate: onOrBeforeDate, source: "ECB" };
    try {
      const [baseRates, quoteRates] = await Promise.all([
        this.#euroRates(base, onOrBeforeDate),
        this.#euroRates(quote, onOrBeforeDate),
      ]);
      const candidateDates = [...new Set([...baseRates.keys(), ...quoteRates.keys()])]
        .filter((date) => date <= onOrBeforeDate && (base === "EUR" || baseRates.has(date)) && (quote === "EUR" || quoteRates.has(date)))
        .sort()
        .reverse();
      const publicationDate = candidateDates[0];
      if (!publicationDate) return null;
      const basePerEuro = base === "EUR" ? new Decimal(1) : new Decimal(baseRates.get(publicationDate)!);
      const quotePerEuro = quote === "EUR" ? new Decimal(1) : new Decimal(quoteRates.get(publicationDate)!);
      return { rate: quotePerEuro.div(basePerEuro).toSignificantDigits(20).toString(), publicationDate, source: "ECB" };
    } catch {
      return null;
    }
  }

  async #euroRates(currency: string, onOrBeforeDate: string): Promise<Map<string, string>> {
    if (currency === "EUR") return new Map([[onOrBeforeDate, "1"]]);
    const url = new URL(`https://data-api.ecb.europa.eu/service/data/EXR/D.${currency}.EUR.SP00.A`);
    url.searchParams.set("startPeriod", subtractDays(onOrBeforeDate, 10));
    url.searchParams.set("endPeriod", onOrBeforeDate);
    url.searchParams.set("format", "csvdata");
    const response = await this.#fetch(url, { method: "GET", headers: { accept: "text/csv" }, redirect: "error" });
    if (!response.ok) return new Map();
    const rows = parse(await response.text(), { columns: true, skip_empty_lines: true, bom: true }) as Array<Record<string, unknown>>;
    const output = new Map<string, string>();
    for (const row of rows) {
      const date = String(row.TIME_PERIOD ?? "");
      const rate = normalizeOfficialRate(row.OBS_VALUE);
      if (/^\d{4}-\d{2}-\d{2}$/.test(date) && rate) output.set(date, rate);
    }
    return output;
  }
}

interface NbuResponseRow {
  cc?: unknown;
  rate?: unknown;
  rate_per_unit?: unknown;
  exchangedate?: unknown;
}

function validateHistoryInput(input: HistoricalRateLoadInput): string[] {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(input.startDate) || !/^\d{4}-\d{2}-\d{2}$/u.test(input.endDate)) {
    throw new Error("FX_DATE_INVALID");
  }
  if (input.startDate > input.endDate) throw new Error("FX_DATE_RANGE_INVALID");
  const currencies = [...new Set(input.currencies.map((currency) => currency.trim().toUpperCase()))];
  if (currencies.some((currency) => !/^[A-Z]{3,8}$/u.test(currency))) throw new Error("FX_PAIR_INVALID");
  return currencies;
}

function parseNbuDate(value: unknown): string | null {
  const match = String(value ?? "").match(/^(\d{2})\.(\d{2})\.(\d{4})$/u);
  if (!match) return null;
  const [, day, month, year] = match;
  return `${year}-${month}-${day}`;
}

export class EcbHistoricalRateLoader implements HistoricalRateLoader {
  readonly name = "ECB" as const;
  readonly #fetch: FetchImplementation;

  constructor({ fetchImpl = guardedFetch }: { fetchImpl?: FetchImplementation } = {}) {
    this.#fetch = fetchImpl;
  }

  async load(input: HistoricalRateLoadInput): Promise<HistoricalRateEdge[]> {
    const currencies = validateHistoryInput(input).filter((currency) => currency !== "EUR").sort();
    if (currencies.length === 0) return [];
    const url = new URL(`https://data-api.ecb.europa.eu/service/data/EXR/D.${currencies.join("+")}.EUR.SP00.A`);
    url.searchParams.set("startPeriod", input.startDate);
    url.searchParams.set("endPeriod", input.endDate);
    url.searchParams.set("format", "csvdata");
    const response = await this.#fetch(url, { method: "GET", headers: { accept: "text/csv" }, redirect: "error" });
    if (!response.ok) throw new Error("ECB_HISTORY_UNAVAILABLE");
    const rows = parse(await response.text(), { columns: true, skip_empty_lines: true, bom: true }) as Array<Record<string, unknown>>;
    const edges: HistoricalRateEdge[] = [];
    for (const row of rows) {
      const currency = String(row.CURRENCY ?? "").toUpperCase();
      const publicationDate = String(row.TIME_PERIOD ?? "");
      const rate = normalizeOfficialRate(row.OBS_VALUE);
      if (!currencies.includes(currency) || !/^\d{4}-\d{2}-\d{2}$/u.test(publicationDate) || !rate) continue;
      edges.push({ base: "EUR", quote: currency, rate, publicationDate, source: "ECB" });
    }
    return edges;
  }
}

export class NbuHistoricalRateLoader implements HistoricalRateLoader {
  readonly name = "NBU" as const;
  readonly #fetch: FetchImplementation;

  constructor({ fetchImpl = guardedFetch }: { fetchImpl?: FetchImplementation } = {}) {
    this.#fetch = fetchImpl;
  }

  async load(input: HistoricalRateLoadInput): Promise<HistoricalRateEdge[]> {
    const currencies = validateHistoryInput(input).filter((currency) => currency !== "UAH").sort();
    const responses = await Promise.all(currencies.map(async (currency) => {
      const url = new URL("https://bank.gov.ua/NBU_Exchange/exchange_site");
      url.searchParams.set("start", input.startDate.replaceAll("-", ""));
      url.searchParams.set("end", input.endDate.replaceAll("-", ""));
      url.searchParams.set("valcode", currency.toLowerCase());
      url.searchParams.set("sort", "exchangedate");
      url.searchParams.set("order", "asc");
      url.searchParams.set("json", "");
      const response = await this.#fetch(url, { method: "GET", headers: { accept: "application/json" }, redirect: "error" });
      if (!response.ok) throw new Error("NBU_HISTORY_UNAVAILABLE");
      const rows = await response.json() as NbuResponseRow[];
      return Array.isArray(rows) ? rows : [];
    }));
    const edges: HistoricalRateEdge[] = [];
    for (const [index, rows] of responses.entries()) {
      const requestedCurrency = currencies[index];
      if (!requestedCurrency) continue;
      for (const row of rows) {
        const currency = String(row.cc ?? requestedCurrency).toUpperCase();
        const publicationDate = parseNbuDate(row.exchangedate);
        const rate = normalizeOfficialRate(row.rate_per_unit ?? row.rate);
        if (currency !== requestedCurrency || !publicationDate || !rate) continue;
        edges.push({ base: currency, quote: "UAH", rate, publicationDate, source: "NBU" });
      }
    }
    return edges;
  }
}

export class NbuRateProvider implements OfficialRateProvider {
  readonly name = "NBU" as const;
  readonly #fetch: FetchImplementation;

  constructor({ fetchImpl = guardedFetch }: { fetchImpl?: FetchImplementation } = {}) {
    this.#fetch = fetchImpl;
  }

  async getRate(base: string, quote: string, onOrBeforeDate: string): Promise<OfficialFxRate | null> {
    if (base === quote) return { rate: "1", publicationDate: onOrBeforeDate, source: "NBU" };
    for (let daysBack = 0; daysBack <= 10; daysBack += 1) {
      const requestedDate = subtractDays(onOrBeforeDate, daysBack);
      const [baseRate, quoteRate] = await Promise.all([
        this.#uahPerCurrency(base, requestedDate),
        this.#uahPerCurrency(quote, requestedDate),
      ]);
      if (!baseRate || !quoteRate || baseRate.publicationDate !== quoteRate.publicationDate) continue;
      return {
        rate: new Decimal(baseRate.rate).div(quoteRate.rate).toSignificantDigits(20).toString(),
        publicationDate: baseRate.publicationDate,
        source: "NBU",
      };
    }
    return null;
  }

  async #uahPerCurrency(currency: string, date: string): Promise<{ rate: string; publicationDate: string } | null> {
    if (currency === "UAH") return { rate: "1", publicationDate: date };
    try {
      const url = new URL("https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange");
      url.searchParams.set("valcode", currency);
      url.searchParams.set("date", date.replaceAll("-", ""));
      url.searchParams.set("json", "");
      const response = await this.#fetch(url, { method: "GET", headers: { accept: "application/json" }, redirect: "error" });
      if (!response.ok) return null;
      const rows = await response.json() as NbuResponseRow[];
      const row = Array.isArray(rows) ? rows[0] : undefined;
      const rate = normalizeOfficialRate(row?.rate);
      const publicationDate = parseNbuDate(row?.exchangedate);
      if (!rate || !publicationDate) return null;
      return { rate, publicationDate };
    } catch {
      return null;
    }
  }
}

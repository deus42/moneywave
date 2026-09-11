import Decimal from "decimal.js";

export type HistoricalRateSource = "ECB" | "NBU";

export interface HistoricalRateEdge {
  base: string;
  quote: string;
  rate: string;
  publicationDate: string;
  source: HistoricalRateSource;
}

export interface HistoricalRateLoadInput {
  currencies: readonly string[];
  startDate: string;
  endDate: string;
}

export interface HistoricalRateLoader {
  readonly name: HistoricalRateSource;
  load(input: HistoricalRateLoadInput): Promise<HistoricalRateEdge[]>;
}

export interface ResolvedHistoricalRate {
  rate: string;
  publicationDate: string;
  source: HistoricalRateSource | "identity";
}

function normalizeCurrency(value: string): string {
  const currency = value.trim().toUpperCase();
  if (!/^[A-Z]{3,8}$/u.test(currency)) throw new Error("FX_PAIR_INVALID");
  return currency;
}

function assertDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || Number.isNaN(new Date(`${value}T00:00:00Z`).getTime())) {
    throw new Error("FX_DATE_INVALID");
  }
}

function normalizeRate(value: string): string {
  let rate: Decimal;
  try {
    rate = new Decimal(value);
  } catch {
    throw new Error("FX_RATE_INVALID");
  }
  if (!rate.isFinite() || !rate.gt(0)) throw new Error("FX_RATE_INVALID");
  return rate.toSignificantDigits(20).toString();
}

interface GraphEdge {
  currency: string;
  rate: Decimal;
}

function resolveAtDate(
  edges: readonly HistoricalRateEdge[],
  base: string,
  quote: string,
): string | null {
  const graph = new Map<string, GraphEdge[]>();
  const add = (from: string, to: string, rate: Decimal) => {
    const connections = graph.get(from) ?? [];
    connections.push({ currency: to, rate });
    graph.set(from, connections);
  };
  for (const edge of edges) {
    const rate = new Decimal(edge.rate);
    add(edge.base, edge.quote, rate);
    add(edge.quote, edge.base, new Decimal(1).div(rate));
  }

  const queue: Array<{ currency: string; rate: Decimal; visited: Set<string> }> = [{
    currency: base,
    rate: new Decimal(1),
    visited: new Set([base]),
  }];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    for (const connection of graph.get(current.currency) ?? []) {
      if (current.visited.has(connection.currency)) continue;
      const rate = current.rate.mul(connection.rate);
      if (connection.currency === quote) return rate.toSignificantDigits(20).toString();
      if (current.visited.size >= 3) continue;
      queue.push({
        currency: connection.currency,
        rate,
        visited: new Set([...current.visited, connection.currency]),
      });
    }
  }
  return null;
}

export class HistoricalRateBook {
  readonly #edges: readonly HistoricalRateEdge[];

  constructor(edges: readonly HistoricalRateEdge[]) {
    this.#edges = edges.map((edge) => {
      const base = normalizeCurrency(edge.base);
      const quote = normalizeCurrency(edge.quote);
      if (base === quote) throw new Error("FX_EDGE_IDENTITY_INVALID");
      assertDate(edge.publicationDate);
      return { ...edge, base, quote, rate: normalizeRate(edge.rate) };
    });
  }

  resolve(baseInput: string, quoteInput: string, requestedDate: string): ResolvedHistoricalRate | null {
    const base = normalizeCurrency(baseInput);
    const quote = normalizeCurrency(quoteInput);
    assertDate(requestedDate);
    if (base === quote) return { rate: "1", publicationDate: requestedDate, source: "identity" };

    for (const source of ["ECB", "NBU"] as const) {
      const sourceEdges = this.#edges.filter((edge) => edge.source === source && edge.publicationDate <= requestedDate);
      const dates = [...new Set(sourceEdges.map(({ publicationDate }) => publicationDate))].sort().reverse();
      for (const publicationDate of dates) {
        const rate = resolveAtDate(
          sourceEdges.filter((edge) => edge.publicationDate === publicationDate),
          base,
          quote,
        );
        if (rate) return { rate, publicationDate, source };
      }
    }
    return null;
  }
}

export async function loadHistoricalRateBook(input: HistoricalRateLoadInput & {
  loaders: readonly HistoricalRateLoader[];
}): Promise<HistoricalRateBook> {
  if (input.loaders.length === 0) throw new Error("FX_LOADERS_EMPTY");
  assertDate(input.startDate);
  assertDate(input.endDate);
  if (input.startDate > input.endDate) throw new Error("FX_DATE_RANGE_INVALID");
  const currencies = [...new Set(input.currencies.map(normalizeCurrency))];
  const loaded = await Promise.all(input.loaders.map((loader) => loader.load({
    currencies,
    startDate: input.startDate,
    endDate: input.endDate,
  })));
  return new HistoricalRateBook(loaded.flat());
}

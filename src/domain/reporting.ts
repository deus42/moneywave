export const REPORT_PERIODS = ["30d", "90d", "12m", "24m", "all"] as const;
export type ReportPeriod = typeof REPORT_PERIODS[number] | `${number}-${number}`;
export type ReportCurrency = "UAH" | "EUR" | "USD";

const PERIODS = new Set<ReportPeriod>(REPORT_PERIODS);
export const REPORT_CURRENCIES: readonly ReportCurrency[] = ["UAH", "EUR", "USD"];

export function isReportPeriod(value: string): value is ReportPeriod {
  return PERIODS.has(value as ReportPeriod) || parseReportMonth(value) !== null;
}

export function parseReportPeriod(value: string | string[] | undefined): ReportPeriod {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && isReportPeriod(candidate) ? candidate : "24m";
}

export function parseReportCurrency(
  value: string | string[] | undefined,
  available: readonly string[] = REPORT_CURRENCIES,
): ReportCurrency {
  void available;
  const candidate = (Array.isArray(value) ? value[0] : value)?.trim().toUpperCase();
  return REPORT_CURRENCIES.includes(candidate as ReportCurrency) ? candidate as ReportCurrency : "UAH";
}

const REPORT_MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export function parseReportMonth(value: string | string[] | undefined): string | null {
  const candidate = (Array.isArray(value) ? value[0] : value)?.trim();
  return candidate && REPORT_MONTH_PATTERN.test(candidate) ? candidate : null;
}

export function reportMonthRange(month: string): { startAt: string; endAt: string } {
  const canonical = parseReportMonth(month);
  if (!canonical) throw new Error("REPORT_MONTH_INVALID");
  const start = requireDate(`${canonical}-01T00:00:00.000Z`);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  return { startAt: start.toISOString(), endAt: end.toISOString() };
}

export function selectedReportMonth(value: string | string[] | undefined, now = new Date()): string {
  const current = now.toISOString().slice(0, 7);
  const selected = parseReportMonth(value);
  return selected && selected <= current ? selected : current;
}

export function adjacentReportMonth(month: string, offset: number): string {
  const date = new Date(reportMonthRange(month).startAt);
  date.setUTCMonth(date.getUTCMonth() + offset);
  return date.toISOString().slice(0, 7);
}

export function reportMonthAsOf(month: string, now = new Date()): string {
  const end = new Date(new Date(reportMonthRange(month).endAt).valueOf() - 1).toISOString().slice(0, 10);
  return end < now.toISOString().slice(0, 10) ? end : now.toISOString().slice(0, 10);
}

function requireDate(value: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) throw new Error("REPORT_DATE_INVALID");
  return date;
}

function shiftUtcYears(date: Date, years: number): void {
  const day = date.getUTCDate();
  const month = date.getUTCMonth();
  date.setUTCDate(1);
  date.setUTCFullYear(date.getUTCFullYear() + years);
  date.setUTCMonth(month);
  const daysInMonth = new Date(Date.UTC(date.getUTCFullYear(), month + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, daysInMonth));
}

export function reportPeriodStart(anchor: string, period: ReportPeriod): string | null {
  if (parseReportMonth(period)) return reportMonthRange(period).startAt;
  if (period === "all") return null;
  const date = requireDate(anchor);
  date.setUTCHours(0, 0, 0, 0);
  if (period === "30d" || period === "90d") {
    date.setUTCDate(date.getUTCDate() - (period === "30d" ? 30 : 90));
  } else if (period === "24m") {
    shiftUtcYears(date, -2);
  } else {
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() - 11);
  }
  return date.toISOString();
}

export function previousReportPeriodRange(
  anchor: string,
  period: ReportPeriod,
): { startAt: string; endAt: string } | null {
  if (parseReportMonth(period)) return reportMonthRange(adjacentReportMonth(period, -1));
  const currentStart = reportPeriodStart(anchor, period);
  if (!currentStart) return null;
  const start = requireDate(currentStart);
  const endAt = start.toISOString();
  if (period === "30d" || period === "90d") {
    start.setUTCDate(start.getUTCDate() - (period === "30d" ? 30 : 90));
  } else if (period === "24m") {
    shiftUtcYears(start, -2);
  } else {
    start.setUTCMonth(start.getUTCMonth() - 12);
  }
  return { startAt: start.toISOString(), endAt };
}

export function buildMonthRange(start: string, end: string): string[] {
  const first = requireDate(start);
  const last = requireDate(end);
  first.setUTCDate(1);
  first.setUTCHours(0, 0, 0, 0);
  last.setUTCDate(1);
  last.setUTCHours(0, 0, 0, 0);
  if (first > last) return [];
  const months: string[] = [];
  while (first <= last) {
    months.push(`${first.getUTCFullYear()}-${String(first.getUTCMonth() + 1).padStart(2, "0")}`);
    first.setUTCMonth(first.getUTCMonth() + 1);
  }
  return months;
}

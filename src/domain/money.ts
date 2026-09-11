import Decimal from "decimal.js";

export interface Money {
  amountMinor: bigint;
  currency: string;
}

const INT64_MIN = -9_223_372_036_854_775_808n;
const INT64_MAX = 9_223_372_036_854_775_807n;

const MINOR_DIGITS: Readonly<Record<string, number>> = {
  AUD: 2,
  BTC: 8,
  CAD: 2,
  CHF: 2,
  CZK: 2,
  DKK: 2,
  EUR: 2,
  GBP: 2,
  HUF: 2,
  MDL: 2,
  NOK: 2,
  PLN: 2,
  RON: 2,
  SEK: 2,
  UAH: 2,
  USD: 2,
};

export function currencyMinorDigits(currency: string): number {
  const normalized = currency.trim().toUpperCase();
  const digits = MINOR_DIGITS[normalized];
  if (digits === undefined) {
    throw new Error("CURRENCY_UNSUPPORTED");
  }
  return digits;
}

function normalizeDecimalInput(value: string | number): string {
  const compact = String(value).trim().replace(/[\s\u00a0]/g, "");
  if (compact.length === 0) {
    throw new Error("MONEY_REQUIRED");
  }

  const comma = compact.lastIndexOf(",");
  const dot = compact.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) {
    const decimalSeparator = comma > dot ? "," : ".";
    const thousandsSeparator = decimalSeparator === "," ? /\./g : /,/g;
    return compact.replace(thousandsSeparator, "").replace(decimalSeparator, ".");
  }
  return compact.replace(",", ".");
}

export function requireInt64(value: bigint): bigint {
  if (value < INT64_MIN || value > INT64_MAX) {
    throw new Error("MONEY_INT64_RANGE");
  }
  return value;
}

export function parseMinorUnits(value: string | number, currency: string): bigint {
  const digits = currencyMinorDigits(currency);
  let decimal: Decimal;
  try {
    decimal = new Decimal(normalizeDecimalInput(value));
  } catch {
    throw new Error("MONEY_INVALID");
  }
  if (!decimal.isFinite()) {
    throw new Error("MONEY_INVALID");
  }

  const scaled = decimal.mul(new Decimal(10).pow(digits));
  if (!scaled.isInteger()) {
    throw new Error("MONEY_PRECISION");
  }
  return requireInt64(BigInt(scaled.toFixed(0)));
}

export function formatMinorUnits(amountMinor: bigint, currency: string): string {
  const digits = currencyMinorDigits(currency);
  const sign = amountMinor < 0n ? "-" : "";
  const absolute = amountMinor < 0n ? -amountMinor : amountMinor;
  if (digits === 0) {
    return `${sign}${absolute}`;
  }
  const scale = 10n ** BigInt(digits);
  return `${sign}${absolute / scale}.${String(absolute % scale).padStart(digits, "0")}`;
}

export function addMoney(left: Money, right: Money): Money {
  const leftCurrency = left.currency.toUpperCase();
  if (leftCurrency !== right.currency.toUpperCase()) {
    throw new Error("MONEY_CURRENCY_MISMATCH");
  }
  return { amountMinor: requireInt64(left.amountMinor + right.amountMinor), currency: leftCurrency };
}

export function sumMinor(values: readonly bigint[]): bigint {
  return values.reduce((sum, value) => requireInt64(sum + value), 0n);
}

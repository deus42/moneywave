import Decimal from "decimal.js";

import { parseMinorUnits } from "@/domain/money";

export interface PrivatFxDescriptionEvidence {
  soldAmountMinor: bigint;
  soldCurrency: string;
  statedRate: string;
}

function normalizeDecimal(value: string): string {
  const compact = value.trim().replace(/[\s\u00a0\u202f'’]/g, "");
  const comma = compact.lastIndexOf(",");
  const dot = compact.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) {
    const decimalSeparator = comma > dot ? "," : ".";
    const thousandsSeparator = decimalSeparator === "," ? /\./g : /,/g;
    return compact.replace(thousandsSeparator, "").replace(decimalSeparator, ".");
  }
  return compact.replace(",", ".");
}

export function parsePrivatFxDescription(value: string): PrivatFxDescriptionEvidence | null {
  const normalized = value.normalize("NFKC");
  if (!/(?:гривн[а-яіїєґi]*\s+в[іїi]д\s+продажу|proceeds\s+from\s+(?:the\s+)?sale)/iu.test(normalized)) return null;
  const amountMatches = [...normalized.matchAll(/([0-9][0-9\s\u00a0\u202f.,'’]*)\s*([A-Z]{3})\b/giu)];
  const amountMatch = amountMatches.at(-1);
  const rateMatch = normalized.match(/(?:курс\p{L}*|rate)[^0-9]{0,30}([0-9]+(?:[.,][0-9]+)?)/iu);
  if (!amountMatch?.[1] || !amountMatch[2] || !rateMatch?.[1]) return null;
  const soldCurrency = amountMatch[2].toUpperCase();
  try {
    const soldAmountMinor = parseMinorUnits(normalizeDecimal(amountMatch[1]), soldCurrency);
    const rate = new Decimal(normalizeDecimal(rateMatch[1]));
    if (soldAmountMinor <= 0n || !rate.isFinite() || rate.lte(0)) return null;
    return { soldAmountMinor, soldCurrency, statedRate: rate.toSignificantDigits(20).toString() };
  } catch {
    return null;
  }
}

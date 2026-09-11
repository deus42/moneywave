import type { OwnerScope } from "@/server/import/types";

export interface CategoryTransaction {
  id: string;
  description: string;
  direction: "debit" | "credit";
  ownerScope: OwnerScope;
  entryKind: string;
  sourceCategory?: string;
}

export interface CategoryRule {
  contains: string;
  categoryCode: string;
}

export interface CategoryClassifier {
  categorize(description: string, allowedCategoryCodes: readonly string[]): Promise<{ categoryCode: string; confidence: number }>;
}

export type CategoryResult = {
  state: "assigned";
  categoryCode: string;
  method: "manual" | "user_rule" | "deterministic" | "merchant_heuristic" | "openai_codex" | "bank";
  confidence: number | null;
  needsReview: boolean;
} | {
  state: "categorization_pending";
  reasonCode: string;
};

const DETERMINISTIC_ENTRY_CATEGORIES: Readonly<Record<string, string>> = {
  business_income: "gross_income",
  tax: "tax",
  mandatory_payment: "mandatory_contributions",
  business_expense: "business_expense",
  owner_draw: "owner_draw",
  explicit_fee: "bank_fee",
  fx_sell: "fx_cost",
  fx_buy: "fx_cost",
};

export function sanitizeForCategorization(description: string): string {
  return description
    .normalize("NFKC")
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, " [redacted] ")
    .replace(/\b[A-Z]{2}\d{2}[A-Z0-9]{10,32}\b/gi, " [redacted] ")
    .replace(/\b(?:ref(?:erence)?|reference|реф(?:еренс)?|ід|id)\s*[:#-]?\s*[A-Z0-9_-]+\b/gi, " [redacted] ")
    .replace(/(?:\+?\d[\s().-]*){8,}/g, " [redacted] ")
    .replace(/\b(?:\d[ -]?){12,19}\b/g, " [redacted] ")
    .replace(/\b\d+(?:[.,]\d+)?\s*(?:UAH|USD|EUR|GBP|PLN|CHF|₴|\$|€)\b/gi, " [redacted] ")
    .replace(/\d+/g, " [redacted] ")
    .replace(/\s+/g, " ")
    .trim();
}

function assigned(
  categoryCode: string,
  method: Extract<CategoryResult, { state: "assigned" }>["method"],
  confidence: number | null = null,
): CategoryResult {
  return { state: "assigned", categoryCode, method, confidence, needsReview: confidence !== null && confidence < 0.8 };
}

function matchingRule(description: string, rules: readonly CategoryRule[]): CategoryRule | undefined {
  const normalized = description.normalize("NFKC").toLocaleLowerCase("uk");
  return rules.find(({ contains }) => normalized.includes(contains.normalize("NFKC").toLocaleLowerCase("uk")));
}

export class CategorizationService {
  async categorize(transaction: CategoryTransaction, context: {
    manualCategoryCode?: string;
    userRules: readonly CategoryRule[];
    merchantHeuristics: readonly CategoryRule[];
    bankCategoryMap: Readonly<Record<string, string>>;
    ai?: CategoryClassifier;
    allowedCategoryCodes: readonly string[];
  }): Promise<CategoryResult> {
    const allowed = new Set(context.allowedCategoryCodes);
    const requireAllowed = (categoryCode: string): string => {
      if (!allowed.has(categoryCode)) throw new Error("CATEGORY_NOT_ALLOWED");
      return categoryCode;
    };

    if (context.manualCategoryCode) return assigned(requireAllowed(context.manualCategoryCode), "manual");
    const userRule = matchingRule(transaction.description, context.userRules);
    if (userRule) return assigned(requireAllowed(userRule.categoryCode), "user_rule");
    const deterministic = DETERMINISTIC_ENTRY_CATEGORIES[transaction.entryKind];
    if (deterministic && allowed.has(deterministic)) return assigned(deterministic, "deterministic");
    const heuristic = matchingRule(transaction.description, context.merchantHeuristics);
    if (heuristic) return assigned(requireAllowed(heuristic.categoryCode), "merchant_heuristic");

    const aiEligible = transaction.direction === "debit"
      && transaction.description.trim().length > 0
      && ["unclassified", "business_expense", "terminal_personal_expense"].includes(transaction.entryKind);
    if (aiEligible && context.ai) {
      try {
        const result = await context.ai.categorize(transaction.description, context.allowedCategoryCodes);
        if (!allowed.has(result.categoryCode) || result.confidence < 0 || result.confidence > 1) {
          return { state: "categorization_pending", reasonCode: "OPENAI_OUTPUT_INVALID" };
        }
        return assigned(result.categoryCode, "openai_codex", result.confidence);
      } catch (error) {
        return {
          state: "categorization_pending",
          reasonCode: error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : "OPENAI_UNAVAILABLE",
        };
      }
    }
    const bankCategory = transaction.sourceCategory ? context.bankCategoryMap[transaction.sourceCategory] : undefined;
    if (bankCategory) return assigned(requireAllowed(bankCategory), "bank");
    return { state: "categorization_pending", reasonCode: "CATEGORY_UNRESOLVED" };
  }
}

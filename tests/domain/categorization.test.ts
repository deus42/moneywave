import { describe, expect, it } from "vitest";

import { CategorizationService, sanitizeForCategorization } from "@/domain/categorization";

describe("categorization redaction", () => {
  it("removes account/card identifiers, references, amounts, email, and phone before remote AI", () => {
    const input = "SYNTHETIC MERCHANT UA0012345678901234567890123456 card 4444333322221111 ref ABC-123 amount 123.45 UAH mail@example.test +380501234567";
    const sanitized = sanitizeForCategorization(input);
    expect(sanitized).toContain("SYNTHETIC MERCHANT");
    expect(sanitized).not.toMatch(/UA00|4444|123\.45|example|38050|ABC-123/);
    expect(sanitized).not.toMatch(/\d/);
  });
});

describe("categorization priority", () => {
  const transaction = {
    id: "transaction-synthetic",
    description: "SYNTHETIC MERCHANT",
    direction: "debit" as const,
    ownerScope: "PERSONAL" as const,
    entryKind: "unclassified",
    sourceCategory: "Synthetic bank category",
  };

  it("uses manual override before user rules and every lower-priority source", async () => {
    const service = new CategorizationService();
    const result = await service.categorize(transaction, {
      manualCategoryCode: "manual-choice",
      userRules: [{ contains: "merchant", categoryCode: "user-rule" }],
      merchantHeuristics: [{ contains: "merchant", categoryCode: "heuristic" }],
      bankCategoryMap: { "Synthetic bank category": "bank" },
      ai: { categorize: async () => ({ categoryCode: "ai", confidence: 0.99 }) },
      allowedCategoryCodes: ["manual-choice", "user-rule", "heuristic", "bank", "ai"],
    });
    expect(result).toEqual({ state: "assigned", categoryCode: "manual-choice", method: "manual", confidence: null, needsReview: false });
  });

  it("applies deterministic finance rules before merchant heuristics or AI", async () => {
    const service = new CategorizationService();
    const result = await service.categorize({ ...transaction, ownerScope: "SOLE_PROPRIETOR", entryKind: "tax" }, {
      userRules: [],
      merchantHeuristics: [{ contains: "merchant", categoryCode: "heuristic" }],
      bankCategoryMap: {},
      ai: { categorize: async () => ({ categoryCode: "ai", confidence: 0.99 }) },
      allowedCategoryCodes: ["tax", "heuristic", "ai"],
    });
    expect(result).toMatchObject({ state: "assigned", categoryCode: "tax", method: "deterministic" });
  });

  it("auto-applies OpenAI output and flags confidence below 0.80", async () => {
    const service = new CategorizationService();
    const result = await service.categorize(transaction, {
      userRules: [],
      merchantHeuristics: [],
      bankCategoryMap: {},
      ai: { categorize: async () => ({ categoryCode: "food", confidence: 0.79 }) },
      allowedCategoryCodes: ["food", "other"],
    });
    expect(result).toEqual({ state: "assigned", categoryCode: "food", method: "openai_codex", confidence: 0.79, needsReview: true });
  });

  it("returns categorization_pending when eligible OpenAI categorization is unavailable", async () => {
    const service = new CategorizationService();
    const result = await service.categorize(transaction, {
      userRules: [],
      merchantHeuristics: [],
      bankCategoryMap: { "Synthetic bank category": "bank" },
      ai: { categorize: async () => { throw new Error("OPENAI_UNAVAILABLE"); } },
      allowedCategoryCodes: ["bank", "other"],
    });
    expect(result).toEqual({ state: "categorization_pending", reasonCode: "OPENAI_UNAVAILABLE" });
  });
});

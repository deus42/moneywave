import { describe, expect, it } from "vitest";

import {
  classifyPersonalEntry,
  safeMerchantLabel,
} from "@/domain/personal-categorization";

describe("personal categorization", () => {
  it.each([
    ["Продукти та супермаркети", "groceries"],
    ["Кафе, бари, ресторани", "dining"],
    ["Комунальні послуги", "utilities"],
    ["Аптеки", "pharmacy"],
    ["Таксі", "taxi"],
    ["Одяг та взуття", "clothing"],
    ["Поповнення мобільного", "utilities"],
    ["Перекази", "p2p"],
  ])("maps normalized bank category %s to %s", (sourceCategory, categoryCode) => {
    expect(classifyPersonalEntry({
      direction: "debit",
      entryKind: "terminal_personal_expense",
      description: "SYNTHETIC PURCHASE",
      sourceCategory,
    })).toMatchObject({ categoryCode, method: "bank", terminalSpend: true });
  });

  it.each([
    ["SYNTHETIC UBER TRIP", "taxi"],
    ["SYNTHETIC NETFLIX", "streaming"],
    ["SYNTHETIC PHARMACY", "pharmacy"],
    ["SYNTHETIC SUPERMARKET", "groceries"],
  ])("uses a merchant heuristic for %s", (description, categoryCode) => {
    expect(classifyPersonalEntry({
      direction: "debit",
      entryKind: "terminal_personal_expense",
      description,
      sourceCategory: null,
    })).toMatchObject({ categoryCode, method: "merchant_heuristic" });
  });

  it("classifies internal and unlinked transfer shapes without counting them as spending", () => {
    expect(classifyPersonalEntry({ direction: "debit", entryKind: "transfer_out", description: "", sourceCategory: null }))
      .toEqual({ state: "assigned", categoryCode: "transfers", method: "deterministic", confidence: 1, terminalSpend: false });
    expect(classifyPersonalEntry({ direction: "debit", entryKind: "unclassified", description: "SYNTHETIC TRANSFER BETWEEN OWN CARDS", sourceCategory: null }))
      .toEqual({ state: "assigned", categoryCode: "transfers", method: "deterministic", confidence: 0.9, terminalSpend: false });
  });

  it("uses a canonical alias before MCC and MCC before provider labels", () => {
    expect(classifyPersonalEntry({
      direction: "debit",
      entryKind: "terminal_personal_expense",
      description: "SYNTHETIC PURCHASE",
      sourceCategory: "Подорожі",
      mcc: "5411",
      aliasCategoryCode: "education",
    })).toMatchObject({ categoryCode: "education", method: "alias" });
    expect(classifyPersonalEntry({
      direction: "debit",
      entryKind: "terminal_personal_expense",
      description: "SYNTHETIC PURCHASE",
      sourceCategory: "Подорожі",
      mcc: "5411",
    })).toMatchObject({ categoryCode: "groceries", method: "mcc" });
    expect(classifyPersonalEntry({
      direction: "debit",
      entryKind: "transfer_out",
      description: "SYNTHETIC PURCHASE",
      sourceCategory: null,
      mcc: "5411",
      aliasCategoryCode: "education",
    })).toMatchObject({ categoryCode: "transfers", method: "deterministic", terminalSpend: false });
  });

  it.each([
    ["4829", "p2p"],
    ["5533", "transport"],
    ["4582", "travel"],
    ["5399", "shopping"],
    ["5992", "gifts_charity"],
    ["5999", "shopping"],
  ])("maps known MCC %s into canonical category %s", (mcc, categoryCode) => {
    expect(classifyPersonalEntry({
      direction: "debit",
      entryKind: "terminal_personal_expense",
      description: "SYNTHETIC PURCHASE",
      sourceCategory: null,
      mcc,
    })).toMatchObject({ categoryCode, method: "mcc" });
  });

  it("keeps a named external account load out of spending even when MCC indicates money transfer", () => {
    expect(classifyPersonalEntry({
      direction: "debit",
      entryKind: "unclassified",
      description: "SYNTHETIC REVOLUT CARD LOAD",
      sourceCategory: null,
      mcc: "4829",
    })).toMatchObject({ categoryCode: "transfers", terminalSpend: false });
  });

  it("counts an unmatched external P2P debit as terminal spending", () => {
    expect(classifyPersonalEntry({
      direction: "debit",
      entryKind: "terminal_personal_expense",
      description: "SYNTHETIC TRANSFER TO RECIPIENT",
      sourceCategory: "Перекази",
    })).toMatchObject({ categoryCode: "p2p", terminalSpend: true });
  });

  it("categorizes a merchant payment with conversion as spending rather than a transfer", () => {
    expect(classifyPersonalEntry({
      direction: "debit",
      entryKind: "terminal_personal_expense",
      description: "СИНТЕТИЧНА ОПЛАТА З ПОДВІЙНОЮ КОНВЕРТАЦІЄЮ",
      sourceCategory: "Підписки",
    })).toMatchObject({ categoryCode: "subscriptions", terminalSpend: true });
  });

  it("classifies a personal credit as income instead of spending", () => {
    expect(classifyPersonalEntry({ direction: "credit", entryKind: "unclassified", description: "SYNTHETIC CREDIT", sourceCategory: null }))
      .toEqual({ state: "assigned", categoryCode: "personal_income", method: "deterministic", confidence: 0.9, terminalSpend: false });
  });

  it("marks an unknown purchase as eligible for sanitized AI categorization", () => {
    expect(classifyPersonalEntry({
      direction: "debit",
      entryKind: "terminal_personal_expense",
      description: "SYNTHETIC NOVEL MERCHANT",
      sourceCategory: null,
    })).toEqual({ state: "ai_required", merchantLabel: "SYNTHETIC NOVEL MERCHANT", terminalSpend: true });
  });

  it("redacts identifiers, amounts, email, and reference tokens from merchant labels", () => {
    const label = safeMerchantLabel("SYNTHETIC SHOP card 4444333322221111 ref ABC-123 user@example.com 100 UAH");

    expect(label).toContain("SYNTHETIC SHOP");
    expect(label).not.toMatch(/4444|ABC-123|example|100|UAH/);
  });
});

it('keeps explicit bank fees as costs when a provider name appears in the description', () => {
  const result = classifyPersonalEntry({ direction: 'debit', entryKind: 'explicit_fee', sourceCategory: null, description: 'Synthetic Erste statement fee' });
  expect(result).toMatchObject({ state: 'assigned', categoryCode: 'bank_fees' });
});

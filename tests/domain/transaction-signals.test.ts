import { describe, expect, it } from "vitest";

import {
  hasFxSignal,
  hasCashDepositSignal,
  hasCashWithdrawalSignal,
  hasExternalAccountTransferSignal,
  hasMobileTopUpSignal,
  hasMerchantFxPaymentSignal,
  hasOwnTransferSignal,
  hasTransferSignal,
} from "@/domain/transaction-signals";

describe("transaction signals", () => {
  it.each([
    "Перерахування коштів на власний поточний рахунок",
    "Зі своєї картки",
    "На мою картку",
    "Transfer between accounts",
  ])("recognizes transfer evidence in %s", (description) => {
    expect(hasTransferSignal(description)).toBe(true);
  });

  it("does not treat a generic card purchase as a transfer", () => {
    expect(hasTransferSignal("Оплата карткою у магазині")).toBe(false);
  });

  it("separates explicitly own-account transfers from generic transfers", () => {
    expect(hasOwnTransferSignal("Переказ на свою картку")).toBe(true);
    expect(hasOwnTransferSignal("Зарахування зі своєї картки")).toBe(true);
    expect(hasOwnTransferSignal("Перерахування коштів на власний поточний рахунок")).toBe(true);
    expect(hasOwnTransferSignal("Переказ одержувачу")).toBe(false);
    expect(hasOwnTransferSignal("Списання коштів у рамках міграції рахунку")).toBe(true);
  });

  it("recognizes mobile top-ups as terminal payments", () => {
    expect(hasMobileTopUpSignal("Поповнення мобільного")).toBe(true);
    expect(hasMobileTopUpSignal("Mobile top up")).toBe(true);
  });

  it.each([
    "Гривнi вiд продажу 100 USD по курсу",
    "Продаж валюти",
    "Currency exchange",
  ])("recognizes FX evidence in %s", (description) => {
    expect(hasFxSignal(description)).toBe(true);
  });

  it("separates a merchant payment with conversion from an account FX movement", () => {
    const description = "СИНТЕТИЧНА ОПЛАТА З ПОДВІЙНОЮ КОНВЕРТАЦІЄЮ";

    expect(hasFxSignal(description)).toBe(true);
    expect(hasMerchantFxPaymentSignal(description)).toBe(true);
  });

  it("recognizes proven cash and named external-account boundaries without treating generic cash text as evidence", () => {
    expect(hasCashWithdrawalSignal({ direction: "debit", mcc: "6011", description: "SYNTHETIC ATM" })).toBe(true);
    expect(hasCashWithdrawalSignal({ direction: "debit", mcc: null, description: "SYNTHETIC CASH WITHDRAWAL" })).toBe(true);
    expect(hasCashDepositSignal({ direction: "credit", mcc: null, description: "SYNTHETIC CASH DEPOSIT" })).toBe(true);
    expect(hasCashWithdrawalSignal({ direction: "debit", mcc: null, description: "SYNTHETIC CASH SHOP" })).toBe(false);
    expect(hasExternalAccountTransferSignal("SYNTHETIC TRANSFER TO WISE ACCOUNT")).toBe(true);
    expect(hasExternalAccountTransferSignal("SYNTHETIC REVOLUT CARD LOAD")).toBe(true);
    expect(hasExternalAccountTransferSignal("SYNTHETIC TRANSFER TO RECIPIENT")).toBe(false);
  });
});

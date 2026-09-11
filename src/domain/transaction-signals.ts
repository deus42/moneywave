const TRANSFER_PATTERN = /(?:sent\s+money|received\s+money|top[ -]up|переказ|перерахуван|transfer|між\s+(?:карт|рах)|з[іи]?\s+(?:своєї\s+)?карт|на\s+(?:мою\s+)?карт|поповнен|власн(?:ий|ого)?(?:\s+\p{L}+){0,3}\s+рах|card\s+to\s+card)/iu;
const FX_PATTERN = /(?:конверт|обмін\s+валют|продаж\p{L}*\s+валют|купівл\p{L}*\s+валют|гривн[іїi]\s+в[іїi]д\s+продажу|currency\s+exchange|\bfx\b)/iu;
const OWN_TRANSFER_PATTERN = /(?:між\s+(?:власн\p{L}*\s+)?(?:карт|рах)|з[іи]?\s+своєї\s+карт|на\s+(?:мою|свою)\s+карт|власн\p{L}*(?:\s+\p{L}+){0,4}\s+рах|міграці\p{L}*\s+(?:карт|рах)|between\s+(?:own\s+)?(?:accounts|cards)|own\s+(?:account|card)|(?:account|card)\s+migration)/iu;
const MOBILE_TOP_UP_PATTERN = /(?:поповнен\p{L}*\s+мобільн|мобільн\p{L}*\s+поповнен|mobile\s+(?:top[ -]?up|recharge)|phone\s+(?:top[ -]?up|recharge))/iu;
const CASH_WITHDRAWAL_PATTERN = /(?:знятт\p{L}*\s+готів|видач\p{L}*\s+готів|cash\s+withdrawal|withdrawal\s+at|банкомат|\batm\b)/iu;
const CASH_DEPOSIT_PATTERN = /(?:внесен\p{L}*\s+готів|поповнен\p{L}*\s+готів|cash\s+deposit|cash\s+in)/iu;
const CASH_MCC = new Set(["6010", "6011"]);
const EXTERNAL_ACCOUNT_PATTERN = /(?:\bwise\b|\brevolut\b|\berste\b|\bgeorge\b)/iu;
const MERCHANT_FX_PAYMENT_PATTERN = /(?:оплат\p{L}*.{0,80}конверт\p{L}*|покуп\p{L}*.{0,80}конверт\p{L}*|(?:payment|purchase).{0,80}(?:currency\s+)?conversion)/iu;

export function hasTransferSignal(value: string): boolean {
  const normalized = value.normalize("NFKC");
  return !MOBILE_TOP_UP_PATTERN.test(normalized) && TRANSFER_PATTERN.test(normalized);
}

export function hasFxSignal(value: string): boolean {
  return FX_PATTERN.test(value.normalize("NFKC"));
}

export function hasMerchantFxPaymentSignal(value: string): boolean {
  return MERCHANT_FX_PAYMENT_PATTERN.test(value.normalize("NFKC"));
}

export function hasOwnTransferSignal(value: string): boolean {
  return OWN_TRANSFER_PATTERN.test(value.normalize("NFKC"));
}

export function hasMobileTopUpSignal(value: string): boolean {
  return MOBILE_TOP_UP_PATTERN.test(value.normalize("NFKC"));
}

export function hasExternalAccountTransferSignal(value: string): boolean {
  const normalized = value.normalize("NFKC");
  return EXTERNAL_ACCOUNT_PATTERN.test(normalized);
}

export function hasCashWithdrawalSignal(input: {
  direction: "debit" | "credit";
  mcc?: string | null;
  description?: string | null;
}): boolean {
  if (input.direction !== "debit") return false;
  return CASH_MCC.has(input.mcc ?? "") || CASH_WITHDRAWAL_PATTERN.test((input.description ?? "").normalize("NFKC"));
}

export function hasCashDepositSignal(input: {
  direction: "debit" | "credit";
  mcc?: string | null;
  description?: string | null;
}): boolean {
  if (input.direction !== "credit") return false;
  return CASH_MCC.has(input.mcc ?? "") || CASH_DEPOSIT_PATTERN.test((input.description ?? "").normalize("NFKC"));
}

import { sanitizeForCategorization } from "@/domain/categorization";
import { hasExternalAccountTransferSignal, hasFxSignal, hasMerchantFxPaymentSignal, hasOwnTransferSignal } from "@/domain/transaction-signals";
import { categoryForMcc } from "@/server/categorization/mcc";

export interface PersonalCategorizationInput {
  direction: "debit" | "credit";
  entryKind: string;
  description: string | null;
  sourceCategory: string | null;
  mcc?: string | null;
  aliasCategoryCode?: string | null;
}

export type PersonalCategorizationResult = {
  state: "assigned";
  categoryCode: string;
  method: "alias" | "deterministic" | "mcc" | "merchant_heuristic" | "bank";
  confidence: number;
  terminalSpend: boolean;
} | {
  state: "ai_required";
  merchantLabel: string;
  terminalSpend: true;
};

const TRANSFER_KINDS = new Set(["owner_draw", "transfer_in", "transfer_out", "fx_sell", "fx_buy", "unlinked_transfer_in", "unlinked_transfer_out"]);
const BANK_CATEGORY_RULES: ReadonlyArray<[RegExp, string]> = [
  [/(?:поповнен\p{L}*\s+мобільн|mobile\s+(?:top[ -]?up|recharge))/iu, "utilities"],
  [/(?:переказ|перерахуван|transfer|card\s+to\s+card)/iu, "p2p"],
  [/(?:продукт|супермаркет|grocer|food\s*store)/iu, "groceries"],
  [/(?:кафе|бар(?:и|и)?\b|ресторан|їжа\s+поза|cafe|restaurant|dining)/iu, "dining"],
  [/(?:комуналь|utility|інтернет|телеком|мобільн|зв.?язок)/iu, "utilities"],
  [/(?:оренд|іпотек|rent|mortgage)/iu, "rent_mortgage"],
  [/(?:аптек|pharmacy)/iu, "pharmacy"],
  [/(?:лікар|медич|клінік|health|medical)/iu, "medical"],
  [/(?:таксі|taxi)/iu, "taxi"],
  [/(?:громадськ|public\s+transport|автобус|метро|залізнич)/iu, "public_transport"],
  [/(?:палив|азс|fuel|petrol|gas\s+station)/iu, "fuel"],
  [/(?:авто|паркуван|parking|transport)/iu, "transport"],
  [/(?:одяг|взут|clothing|apparel)/iu, "clothing"],
  [/(?:електрон|технік|electronics)/iu, "electronics"],
  [/(?:покупк|shopping|товари)/iu, "shopping"],
  [/(?:подорож|готел|авіа|travel|hotel|airline)/iu, "travel"],
  [/(?:освіт|курс|книг|education)/iu, "education"],
  [/(?:краса|догляд|перукар|beauty|personal\s+care)/iu, "personal_care"],
  [/(?:підписк|subscription)/iu, "subscriptions"],
  [/(?:кіно|театр|музик|розваг|entertainment)/iu, "entertainment"],
  [/(?:спорт|фітнес|fitness|gym)/iu, "fitness"],
  [/(?:подар|благод|gift|charity)/iu, "gifts_charity"],
  [/(?:готів|cash|банкомат|atm)/iu, "cash"],
  [/(?:комісі|fee|commission)/iu, "bank_fees"],
];
const MERCHANT_RULES: ReadonlyArray<[RegExp, string]> = [
  [/(?:\buber\b|\bbolt\b|uklon|taxi)/iu, "taxi"],
  [/(?:netflix|spotify|youtube\s+premium|megogo|apple\.com\/bill)/iu, "streaming"],
  [/(?:pharmacy|apteka|аптек)/iu, "pharmacy"],
  [/(?:supermarket|market|silpo|сільпо|atb|novus|varus|lidl|spar|kaufland|конзум)/iu, "groceries"],
  [/(?:mcdonald|kfc|restaurant|cafe|coffee|pizza|glovo|wolt)/iu, "dining"],
  [/(?:booking\.com|airbnb|ryanair|wizz\s*air|hotel)/iu, "travel"],
  [/(?:steam|playstation|xbox|cinema|multiplex)/iu, "entertainment"],
  [/(?:amazon|rozetka|prom\.ua|aliexpress|ikea)/iu, "shopping"],
  [/(?:zara|uniqlo|h&m|reserved|answear)/iu, "clothing"],
  [/(?:shell|okko|wog|petrol|ina)/iu, "fuel"],
];

function assigned(
  categoryCode: string,
  method: "alias" | "deterministic" | "mcc" | "merchant_heuristic" | "bank",
  confidence: number,
  terminalSpend: boolean,
): PersonalCategorizationResult {
  return { state: "assigned", categoryCode, method, confidence, terminalSpend };
}

function firstRule(value: string, rules: ReadonlyArray<readonly [RegExp, string]>): string | null {
  return rules.find(([pattern]) => pattern.test(value))?.[1] ?? null;
}

export function safeMerchantLabel(description: string): string {
  return sanitizeForCategorization(description)
    .replace(/\[redacted\]/gi, " ")
    .replace(/\b(?:UAH|USD|EUR|GBP|PLN|CHF|RON|MDL)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

export function classifyPersonalEntry(input: PersonalCategorizationInput): PersonalCategorizationResult {
  if (input.entryKind === "explicit_fee") return assigned("bank_fees", "deterministic", 1, true);
  const description = input.description?.normalize("NFKC") ?? "";
  const sourceCategory = input.sourceCategory?.normalize("NFKC") ?? "";
  const searchable = `${sourceCategory} ${description}`;
  const merchantFxPayment = input.direction === "debit" && hasMerchantFxPaymentSignal(searchable);
  if (
    TRANSFER_KINDS.has(input.entryKind)
    || hasOwnTransferSignal(searchable)
    || hasExternalAccountTransferSignal(searchable)
    || (hasFxSignal(searchable) && !merchantFxPayment)
  ) {
    return assigned("transfers", "deterministic", input.entryKind === "unclassified" ? 0.9 : 1, false);
  }
  if (input.direction === "credit") return assigned("personal_income", "deterministic", 0.9, false);

  if (input.aliasCategoryCode) return assigned(input.aliasCategoryCode, "alias", 1, true);
  const mccCategory = categoryForMcc(input.mcc);
  if (mccCategory) return assigned(mccCategory, "mcc", 0.98, true);

  const bankCategory = firstRule(sourceCategory, BANK_CATEGORY_RULES);
  if (bankCategory) return assigned(bankCategory, "bank", 0.92, true);
  const merchantCategory = firstRule(description, MERCHANT_RULES);
  if (merchantCategory) return assigned(merchantCategory, "merchant_heuristic", 0.9, true);
  const merchantLabel = safeMerchantLabel(description);
  if (merchantLabel) return { state: "ai_required", merchantLabel, terminalSpend: true };
  return assigned("other", "deterministic", 0.5, true);
}

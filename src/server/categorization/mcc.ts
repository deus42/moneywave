export const MCC_RULE_VERSION = "mcc-v2";

const EXACT: Readonly<Record<string, string>> = {
  "0742": "pets",
  "4111": "public_transport",
  "4112": "public_transport",
  "4121": "taxi",
  "4511": "travel",
  "4582": "travel",
  "4722": "travel",
  "4812": "utilities",
  "4814": "utilities",
  "4816": "utilities",
  "4829": "p2p",
  "4899": "utilities",
  "4900": "utilities",
  "5200": "home",
  "5211": "home",
  "5231": "home",
  "5251": "home",
  "5261": "home",
  "5399": "shopping",
  "5411": "groceries",
  "5422": "groceries",
  "5441": "groceries",
  "5451": "groceries",
  "5462": "groceries",
  "5499": "groceries",
  "5533": "transport",
  "5541": "fuel",
  "5542": "fuel",
  "5651": "clothing",
  "5691": "clothing",
  "5712": "home",
  "5713": "home",
  "5714": "home",
  "5718": "home",
  "5719": "home",
  "5722": "electronics",
  "5732": "electronics",
  "5734": "electronics",
  "5811": "dining",
  "5812": "dining",
  "5813": "dining",
  "5814": "dining",
  "5815": "digital_services",
  "5816": "digital_services",
  "5817": "digital_services",
  "5818": "digital_services",
  "5912": "pharmacy",
  "5977": "personal_care",
  "5992": "gifts_charity",
  "5995": "pets",
  "5999": "shopping",
  "6010": "cash",
  "6011": "cash",
  "6012": "bank_fees",
  "6051": "bank_fees",
  "6211": "bank_fees",
  "6300": "insurance",
  "7011": "travel",
  "7012": "travel",
  "7230": "personal_care",
  "7297": "personal_care",
  "7298": "personal_care",
  "7523": "parking",
  "7524": "parking",
  "7832": "culture",
  "7841": "culture",
  "7941": "fitness",
  "7997": "fitness",
  "8211": "education",
  "8220": "education",
  "8241": "education",
  "8244": "education",
  "8249": "education",
  "8299": "education",
  "8398": "gifts_charity",
  "9211": "government_services",
  "9222": "government_services",
  "9311": "government_services",
  "9399": "government_services",
};

function normalizedMcc(value: string | null | undefined): string | null {
  const text = String(value ?? "").replace(/\.0+$/u, "").padStart(4, "0");
  return /^\d{4}$/u.test(text) ? text : null;
}

export function categoryForMcc(value: string | null | undefined): string | null {
  const mcc = normalizedMcc(value);
  if (!mcc) return null;
  const exact = EXACT[mcc];
  if (exact) return exact;
  const numeric = Number(mcc);
  if (numeric >= 3000 && numeric <= 3999) return "travel";
  if (numeric >= 5611 && numeric <= 5699) return "clothing";
  if (numeric >= 8011 && numeric <= 8099) return "medical";
  if (numeric >= 7911 && numeric <= 7999) return "entertainment";
  return null;
}

export function normalizeCategoryAlias(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("uk").replace(/\s+/gu, " ").trim();
}

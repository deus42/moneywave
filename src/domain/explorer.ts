export const TRANSACTION_MODES = ["all", "expenses", "income", "transfers", "fx"] as const;
export type TransactionMode = typeof TRANSACTION_MODES[number];
export const TRANSACTION_SORTS = ["newest", "oldest", "largest"] as const;
export type TransactionSort = typeof TRANSACTION_SORTS[number];
export const MODE_LABELS: Record<TransactionMode, string> = { all: "Усі", expenses: "Витрати", income: "Доходи", transfers: "Перекази", fx: "Обмін" };
export const SORT_LABELS: Record<TransactionSort, string> = { newest: "Новіші", oldest: "Старіші", largest: "Найбільші суми" };

export interface MovementRoute {
  sourceAccountId: string | null;
  destinationAccountId: string | null;
  sourceCurrency: string | null;
  destinationCurrency: string | null;
}

export type InspectorTarget = { kind: "transaction" | "movement" | "account"; id: string };

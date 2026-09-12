import Decimal from 'decimal.js';
import { currencyMinorDigits } from '@/domain/money';
import type { CapitalPosition, CapitalView, FinanceCenters } from '@/server/read-model/finance-centers';
import { includeWorkspacePosition } from './capital';
import { summary, type WorkspaceReport, type WorkspaceState } from './model';

const Exact = Decimal.clone({ precision: 50, rounding: Decimal.ROUND_HALF_UP });
const dayBefore = (day: string) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };
const monthEnd = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
const earlier = (a: string, b: string) => (a < b ? a : b);
const later = (a: string, b: string) => (a > b ? a : b);

export interface AccountSavings {
  id: string; name: string; provider: string; currency: string;
  /** Savings scope of the workspace: foreign personal accounts and cash, never Privat/Mono/FOP. */
  workspace: boolean;
  startMinor: string | null; endMinor: string | null;
  nativeStartMinor: string | null; nativeEndMinor: string | null;
  changeMinor: string | null;
  /** Part of the EUR change caused only by a different EUR rate on the end date. */
  revaluationMinor: string | null;
  savedMinor: string | null;
  startObservedAt: string | null; endObservedAt: string | null; carriedForward: boolean;
}

export interface SavingsBridge {
  remainder: number | null; otherAccounts: number; unassigned: number; fx: number | null;
  expected: number | null; saved: number; unexplained: number | null; revaluation: number;
  unknownAccounts: number; unknownOtherAccounts: number;
}

/** Balance change per account between two dated capital views. Missing balances stay unknown, never zero. */
export function accountSavings(start: CapitalView, end: CapitalView,
  include: (position: CapitalPosition) => boolean = includeWorkspacePosition): AccountSavings[] {
  return end.positions.map((last) => {
    const first = start.positions.find((position) => position.id === last.id);
    const known = !!first && first.reportMinor !== null && last.reportMinor !== null;
    let revaluation: bigint | null = null;
    if (known && first) {
      if (last.currency === end.currency) revaluation = 0n;
      else if (first.nativeMinor !== null && last.rate !== null) {
        const scale = new Exact(10).pow(currencyMinorDigits(end.currency) - currencyMinorDigits(last.currency));
        revaluation = BigInt(new Exact(first.nativeMinor).mul(last.rate).mul(scale).toFixed(0)) - BigInt(first.reportMinor!);
      }
    }
    const change = known && first ? BigInt(last.reportMinor!) - BigInt(first.reportMinor!) : null;
    return {
      id: last.id, name: last.name, provider: last.provider, currency: last.currency, workspace: include(last),
      startMinor: first?.reportMinor ?? null, endMinor: last.reportMinor,
      nativeStartMinor: first?.nativeMinor ?? null, nativeEndMinor: last.nativeMinor,
      changeMinor: change?.toString() ?? null, revaluationMinor: revaluation?.toString() ?? null,
      savedMinor: change !== null && revaluation !== null ? (change - revaluation).toString() : null,
      startObservedAt: first?.observedAt ?? null, endObservedAt: last.observedAt,
      carriedForward: last.carriedForward || !!first?.carriedForward,
    };
  });
}

/**
 * Explains the gap between the income remainder and money that stayed on savings accounts.
 * Only known balances contribute; whatever is not explained stays a separate unexplained amount.
 */
export function savingsBridge(input: { remainder: number | null; unknown: number; fx: number | null }, accounts: AccountSavings[]): SavingsBridge {
  const total = (rows: AccountSavings[], key: 'savedMinor' | 'revaluationMinor') => rows.reduce((sum, row) => sum + BigInt(row[key] ?? '0'), 0n);
  const own = accounts.filter((row) => row.workspace), other = accounts.filter((row) => !row.workspace);
  const ownKnown = own.filter((row) => row.savedMinor !== null), otherKnown = other.filter((row) => row.savedMinor !== null);
  const saved = Number(total(ownKnown, 'savedMinor')), otherAccounts = Number(total(otherKnown, 'savedMinor'));
  const expected = input.remainder === null ? null : input.remainder - otherAccounts - input.unknown - (input.fx ?? 0);
  return {
    remainder: input.remainder, otherAccounts, unassigned: input.unknown, fx: input.fx, expected, saved,
    unexplained: expected === null ? null : saved - expected, revaluation: Number(total(ownKnown, 'revaluationMinor')),
    unknownAccounts: own.length - ownKnown.length, unknownOtherAccounts: other.length - otherKnown.length,
  };
}

/** Read-only: balances on the day before the period and at each month end, compared with the period cash flow. */
export async function savingsView(centers: Pick<FinanceCenters, 'capital'>, report: WorkspaceReport, state: WorkspaceState, period: string, today: string) {
  const data = summary(report, state, period, today);
  if (!data.availableRange) return { period: data.period, from: null, to: null, startAsOf: null, endAsOf: null, accounts: [], bridge: null, months: [] };
  const views = new Map<string, CapitalView>();
  const at = async (day: string) => {
    const key = earlier(day, today);
    if (!views.has(key)) views.set(key, await centers.capital(key, 'EUR', undefined, state.cashExpenses));
    return views.get(key)!;
  };
  const from = data.availableRange.from, to = earlier(data.availableRange.to, today);
  const start = await at(dayBefore(from)), end = await at(to);
  const accounts = accountSavings(start, end);
  const bridge = savingsBridge({ remainder: data.manualOnly ? null : data.remainder, unknown: data.unknown, fx: data.fx }, accounts);
  const months = [];
  for (const month of data.months) {
    const monthFrom = later(`${month.month}-01`, from), monthTo = earlier(monthEnd(month.month), to);
    if (monthFrom > monthTo) continue;
    const values = summary(report, state, month.month, today);
    const rows = accountSavings(await at(dayBefore(monthFrom)), await at(monthTo));
    months.push({ month: month.month, from: monthFrom, to: monthTo,
      ...savingsBridge({ remainder: month.manualOnly ? null : values.remainder, unknown: values.unknown, fx: values.fx }, rows) });
  }
  return { period: data.period, from, to, startAsOf: start.asOf, endAsOf: end.asOf, accounts, bridge, months };
}

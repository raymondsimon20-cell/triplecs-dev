/**
 * Orchestrated engine run: fetch live data → run pure engine → auto-execute
 * (guardrail-gated) → build + persist daily plan → archive.
 */
import { getAccounts } from '@/lib/schwab/client';
import { getQuotes } from '@/lib/schwab/client';
import { runEngine } from './engine';
import { loadEngineState, saveEngineState } from './state';
import { autoExecute } from './auto-execute';
import { buildDailyPlan, saveDailyPlan } from './daily-plan';
import { archivePlan } from './plan-archive';
import type { EngineInput, EnginePosition, EngineBalances } from './types';
import type { SchwabAccount } from '@/lib/schwab/types';

export function toEngineInputs(account: SchwabAccount, quotes: Record<string, { last: number }>, spyHigh: number, vix: number, today: string) {
  const positions: EnginePosition[] = account.positions.map((p) => ({
    symbol: p.instrument.symbol,
    marketValue: p.marketValue,
    quantity: p.longQuantity - p.shortQuantity,
    price: quotes[p.instrument.symbol]?.last ?? (p.longQuantity > 0 ? p.marketValue / p.longQuantity : 0),
    putCall: p.instrument.putCall,
    maintenanceRequirement: p.maintenanceRequirement,
  }));
  const balances: EngineBalances = {
    equity: account.balances.liquidationValue,
    afw: account.balances.availableFunds, // AFW (Available For Withdrawal)
    marginDebit: Math.max(0, -account.balances.marginBalance),
    maintenanceRequirement: account.balances.maintenanceRequirement,
    cash: account.balances.cashBalance ?? 0,
  };
  return { positions, balances };
}

export async function runDaily(opts: { accountHash?: string; dryRun?: boolean } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const accounts = await getAccounts();
  const account = opts.accountHash
    ? accounts.find((a) => a.hashValue === opts.accountHash) ?? accounts[0]
    : accounts[0];
  if (!account) throw new Error('No Schwab account available');

  const symbols = Array.from(
    new Set([...account.positions.map((p) => p.instrument.symbol), 'SPY', '$VIX.X', 'UPRO', 'TQQQ', 'SOXL'])
  );
  const quotes = await getQuotes(symbols);
  const state = await loadEngineState();

  const { positions, balances } = toEngineInputs(account, quotes, state.spyHigh, 0, today);
  const input: EngineInput = {
    positions,
    balances,
    market: {
      spyPrice: quotes['SPY']?.last ?? 0,
      spyHigh: state.spyHigh,
      vix: quotes['$VIX.X']?.last ?? 20,
    },
    state,
    today,
  };

  const { signals, nextState } = runEngine(input);
  await saveEngineState(nextState);

  const auto = await autoExecute(
    signals,
    positions,
    balances,
    account.hashValue,
    quotes,
    today,
    opts.dryRun ?? false
  );

  const plan = buildDailyPlan(today, signals, auto.executed);
  await saveDailyPlan(plan);
  await archivePlan({ plan, engineInput: input });

  return { plan, auto, signals };
}

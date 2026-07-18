/** Daily plan: engine signals grouped for the inbox / today panel. */
import { storage, KEYS } from '@/lib/storage';
import type { TradeSignal } from './types';

export interface DailyPlan {
  date: string;
  generatedAt: string;
  trades: TradeSignal[]; // actionable, awaiting approval
  autoExecuted: TradeSignal[];
  alerts: TradeSignal[];
  info: TradeSignal[];
  approvals: Record<string, 'approved' | 'rejected' | 'pending'>;
}

export function buildDailyPlan(
  date: string,
  signals: TradeSignal[],
  autoExecuted: TradeSignal[]
): DailyPlan {
  const autoIds = new Set(autoExecuted.map((s) => s.id));
  const remaining = signals.filter((s) => !autoIds.has(s.id));
  const trades = remaining.filter((s) => s.category === 'trade');
  return {
    date,
    generatedAt: new Date().toISOString(),
    trades,
    autoExecuted,
    alerts: remaining.filter((s) => s.category === 'alert'),
    info: remaining.filter((s) => s.category === 'info'),
    approvals: Object.fromEntries(trades.map((s) => [s.id, 'pending' as const])),
  };
}

export async function saveDailyPlan(plan: DailyPlan): Promise<void> {
  await storage.set(KEYS.dailyPlan(plan.date), plan);
}

export async function loadDailyPlan(date: string): Promise<DailyPlan | null> {
  return storage.get<DailyPlan>(KEYS.dailyPlan(date));
}

export async function setApproval(
  date: string,
  signalId: string,
  decision: 'approved' | 'rejected'
): Promise<DailyPlan | null> {
  const plan = await loadDailyPlan(date);
  if (!plan) return null;
  plan.approvals[signalId] = decision;
  await saveDailyPlan(plan);
  return plan;
}

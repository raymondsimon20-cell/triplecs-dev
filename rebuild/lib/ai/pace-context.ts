/** FIRE pace context: income run-rate vs target, for the AI narrative. */
import { storage } from '@/lib/storage';

export interface PaceStats {
  monthlyIncomeTarget: number;
  trailing30dIncome: number;
  trailing90dIncome: number;
  fireTargetEquity: number;
  currentEquity: number;
}

const KEY = 'pace-stats';

export async function savePaceStats(stats: PaceStats): Promise<void> {
  await storage.set(KEY, stats);
}

export async function buildPaceContext(): Promise<string> {
  const stats = await storage.get<PaceStats>(KEY);
  if (!stats) return '';
  const pacePct = stats.monthlyIncomeTarget > 0 ? (stats.trailing30dIncome / stats.monthlyIncomeTarget) * 100 : 0;
  const firePct = stats.fireTargetEquity > 0 ? (stats.currentEquity / stats.fireTargetEquity) * 100 : 0;
  return `\n## FIRE pace\n- Trailing 30d income $${Math.round(stats.trailing30dIncome).toLocaleString()} vs monthly target $${Math.round(stats.monthlyIncomeTarget).toLocaleString()} (${pacePct.toFixed(0)}% of pace)\n- Equity $${Math.round(stats.currentEquity).toLocaleString()} vs FIRE target $${Math.round(stats.fireTargetEquity).toLocaleString()} (${firePct.toFixed(1)}%)`;
}

/** Plan archival + replay. */
import { storage, KEYS } from '@/lib/storage';
import type { DailyPlan } from './daily-plan';
import type { EngineInput } from './types';

export interface ArchivedPlan {
  plan: DailyPlan;
  /** The exact engine input, so a run can be replayed deterministically. */
  engineInput: EngineInput;
}

export async function archivePlan(archived: ArchivedPlan): Promise<void> {
  await storage.set(KEYS.planArchive(archived.plan.date), archived);
}

export async function loadArchivedPlan(date: string): Promise<ArchivedPlan | null> {
  return storage.get<ArchivedPlan>(KEYS.planArchive(date));
}

export async function listArchivedDates(): Promise<string[]> {
  const keys = await storage.list('plan-archive-');
  return keys.map((k) => k.replace('plan-archive-', '')).sort().reverse();
}

/** Replay an archived run through the current engine (for tuning/regression). */
export async function replay(date: string) {
  const archived = await loadArchivedPlan(date);
  if (!archived) return null;
  const { runEngine } = await import('./engine');
  return runEngine(archived.engineInput);
}

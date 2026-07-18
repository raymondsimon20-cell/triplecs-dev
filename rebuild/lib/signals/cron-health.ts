/** Cron health tracking — surfaces silent scheduled-function failures. */
import { storage, KEYS } from '@/lib/storage';

export interface CronRun {
  job: string;
  lastRunAt: string;
  lastStatus: 'ok' | 'error';
  lastError?: string;
  consecutiveFailures: number;
}

export type CronHealth = Record<string, CronRun>;

export async function recordCronRun(
  job: string,
  status: 'ok' | 'error',
  error?: string
): Promise<void> {
  const health = (await storage.get<CronHealth>(KEYS.cronHealth)) ?? {};
  const prev = health[job];
  health[job] = {
    job,
    lastRunAt: new Date().toISOString(),
    lastStatus: status,
    lastError: error,
    consecutiveFailures: status === 'ok' ? 0 : (prev?.consecutiveFailures ?? 0) + 1,
  };
  await storage.set(KEYS.cronHealth, health);
}

export async function getCronHealth(): Promise<CronHealth> {
  return (await storage.get<CronHealth>(KEYS.cronHealth)) ?? {};
}

/** Jobs that haven't run in > staleHours are flagged. */
export function findStaleJobs(health: CronHealth, staleHours = 30): CronRun[] {
  const cutoff = Date.now() - staleHours * 3600_000;
  return Object.values(health).filter(
    (r) => new Date(r.lastRunAt).getTime() < cutoff || r.lastStatus === 'error'
  );
}

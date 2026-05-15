/**
 * Daily plan archive.
 *
 * Every cron run produces a DailyPlan from buildDailyPlan(). We keep the most
 * recent one in the engine cache for the dashboard. This module persists
 * EVERY run keyed by date so the user can later review:
 *
 *   - What did the engine recommend last Tuesday?
 *   - When did MAINTENANCE_RANKED_TRIM start firing?
 *   - How often did I dismiss tier-2 proposals vs approve them?
 *
 * Cap retention at 90 days (long enough for a quarterly review, short enough
 * to stay well under the Netlify Blobs free-tier limits).
 */

import { getStore } from '@netlify/blobs';
import type { DailyPlan } from './daily-plan';

const STORE_NAME      = 'signal-engine-plan-archive';
const MAX_ENTRIES     = 90;
const INDEX_KEY       = 'index';
const ENTRY_PREFIX    = 'plan-';

interface ArchiveIndex {
  dates: string[];  // ISO YYYY-MM-DD, newest first
  updatedAt: number;
}

/**
 * Append today's plan to the archive. If a plan already exists for today's
 * date it's overwritten — multiple cron runs in one day are treated as
 * iterations of the same plan, not distinct entries.
 */
export async function archiveDailyPlan(plan: DailyPlan): Promise<void> {
  const date = new Date(plan.generatedAt).toISOString().slice(0, 10);
  const store = getStore(STORE_NAME);
  const key   = `${ENTRY_PREFIX}${date}`;

  await store.setJSON(key, plan);

  // Update the index (newest-first, deduped, capped).
  const existing = (await store.get(INDEX_KEY, { type: 'json' })) as ArchiveIndex | null;
  const dates = new Set<string>(existing?.dates ?? []);
  dates.add(date);
  const sortedDesc = Array.from(dates).sort().reverse();

  // Drop entries past the retention window.
  const keepers = sortedDesc.slice(0, MAX_ENTRIES);
  const droppedDates = sortedDesc.slice(MAX_ENTRIES);

  await store.setJSON(INDEX_KEY, {
    dates: keepers,
    updatedAt: Date.now(),
  } satisfies ArchiveIndex);

  // Best-effort cleanup of dropped entries. Failures here aren't fatal —
  // unreferenced keys will be reaped by Netlify Blobs eventually.
  await Promise.all(
    droppedDates.map((d) =>
      store.delete(`${ENTRY_PREFIX}${d}`).catch(() => undefined),
    ),
  );
}

export async function listArchivedPlanDates(): Promise<string[]> {
  const store = getStore(STORE_NAME);
  const index = (await store.get(INDEX_KEY, { type: 'json' })) as ArchiveIndex | null;
  return index?.dates ?? [];
}

export async function getArchivedPlan(date: string): Promise<DailyPlan | null> {
  const store = getStore(STORE_NAME);
  return (await store.get(`${ENTRY_PREFIX}${date}`, { type: 'json' })) as DailyPlan | null;
}

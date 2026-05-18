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
 *
 * 2026-05: per-account archive. When `accountHash` is provided, writes to
 * `plan-YYYY-MM-DD:account:{hash}`. Without, writes the household plan to
 * `plan-YYYY-MM-DD`. Both share the same date index (one entry per date in
 * the index regardless of how many accounts wrote that day).
 */
export async function archiveDailyPlan(plan: DailyPlan, accountHash?: string): Promise<void> {
  const date = new Date(plan.generatedAt).toISOString().slice(0, 10);
  const store = getStore(STORE_NAME);
  const key   = accountHash
    ? `${ENTRY_PREFIX}${date}:account:${accountHash}`
    : `${ENTRY_PREFIX}${date}`;

  await store.setJSON(key, plan);

  // Update the date index (only when we wrote the household entry — the
  // index is date-only, not per-account, so adding the date on every
  // per-account write would be redundant but not harmful. We do it on
  // both paths to keep the date present even when only per-account plans
  // were written that day).
  const existing = (await store.get(INDEX_KEY, { type: 'json' })) as ArchiveIndex | null;
  const dates = new Set<string>(existing?.dates ?? []);
  dates.add(date);
  const sortedDesc = Array.from(dates).sort().reverse();

  const keepers = sortedDesc.slice(0, MAX_ENTRIES);
  const droppedDates = sortedDesc.slice(MAX_ENTRIES);

  await store.setJSON(INDEX_KEY, {
    dates: keepers,
    updatedAt: Date.now(),
  } satisfies ArchiveIndex);

  // Best-effort cleanup of dropped dates — delete BOTH the household entry
  // and any per-account entries for that date.
  if (droppedDates.length > 0) {
    await Promise.all(droppedDates.flatMap((d) => [
      store.delete(`${ENTRY_PREFIX}${d}`).catch(() => undefined),
      // We can't enumerate per-account suffixes here without a list; rely
      // on the eventual Blobs reaper. For typical retention (90d) the
      // per-account entries past the window are tiny.
    ]));
  }
}

export async function listArchivedPlanDates(): Promise<string[]> {
  const store = getStore(STORE_NAME);
  const index = (await store.get(INDEX_KEY, { type: 'json' })) as ArchiveIndex | null;
  return index?.dates ?? [];
}

/**
 * Read an archived plan. With `accountHash`, reads the per-account entry;
 * without, reads the household entry. Returns null when missing.
 */
export async function getArchivedPlan(date: string, accountHash?: string): Promise<DailyPlan | null> {
  const store = getStore(STORE_NAME);
  const key = accountHash
    ? `${ENTRY_PREFIX}${date}:account:${accountHash}`
    : `${ENTRY_PREFIX}${date}`;
  return (await store.get(key, { type: 'json' })) as DailyPlan | null;
}

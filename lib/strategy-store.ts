/**
 * Server-side strategy targets store.
 *
 * The SettingsPanel persists user-customized allocation targets to localStorage,
 * which is fine for the dashboard UI but invisible to the daily cron and the
 * signal engine (which run server-side and have no browser context).
 *
 * This module mirrors strategy targets to Netlify Blobs so the engine can
 * read what the user actually wants their allocation to look like.
 *
 * Two-tier scope (2026-05):
 *   • Global default at key `current` — applies to every account that doesn't
 *     have its own override.
 *   • Per-account override at key `account:{accountHash}` — used by that one
 *     account's engine run. Resolution is override → global → DEFAULT_TARGETS.
 *
 * The SettingsPanel writes to both localStorage and `/api/strategy` (POST) on
 * save; the engine reads via `getServerStrategyTargets(accountHash?)`. Calling
 * without an accountHash returns the global default, which is also the
 * behaviour every legacy caller gets.
 */

import { getStore } from '@netlify/blobs';
import { DEFAULT_TARGETS, type StrategyTargets } from './utils';

const STRATEGY_STORE = 'strategy-targets';
const GLOBAL_KEY     = 'current';
const ACCOUNT_PREFIX = 'account:';

function keyFor(accountHash?: string): string {
  if (!accountHash) return GLOBAL_KEY;
  return `${ACCOUNT_PREFIX}${accountHash}`;
}

interface StoredStrategyTargets extends StrategyTargets {
  updatedAt: number;
}

async function rawGet(key: string): Promise<StoredStrategyTargets | null> {
  try {
    return (await getStore(STRATEGY_STORE).get(key, { type: 'json' })) as StoredStrategyTargets | null;
  } catch (err) {
    console.warn(`[strategy-store] read ${key} failed:`, err);
    return null;
  }
}

/**
 * Resolve effective targets for a given accountHash. Order:
 *   1. Per-account override (if accountHash provided AND override exists).
 *   2. Global default.
 *   3. DEFAULT_TARGETS (compiled-in safety net).
 *
 * Merges stored values over defaults so future schema additions degrade
 * gracefully when an old blob is missing newer fields.
 */
export async function getServerStrategyTargets(accountHash?: string): Promise<StrategyTargets> {
  if (accountHash) {
    const override = await rawGet(keyFor(accountHash));
    if (override) return { ...DEFAULT_TARGETS, ...override };
  }
  const global = await rawGet(GLOBAL_KEY);
  if (!global) return { ...DEFAULT_TARGETS };
  return { ...DEFAULT_TARGETS, ...global };
}

/**
 * Persist a strategy-targets blob.
 *   - accountHash omitted → writes the global default (mirrors legacy behaviour).
 *   - accountHash provided → writes a per-account override.
 */
export async function saveServerStrategyTargets(t: StrategyTargets, accountHash?: string): Promise<void> {
  const payload: StoredStrategyTargets = {
    ...DEFAULT_TARGETS,
    ...t,
    updatedAt: Date.now(),
  };
  await getStore(STRATEGY_STORE).setJSON(keyFor(accountHash), payload);
}

/**
 * Remove a per-account override so the next read falls back to global.
 * No-op when called without an accountHash (the global default is never
 * deleted through this path — it's only ever overwritten).
 */
export async function clearServerStrategyOverride(accountHash: string): Promise<void> {
  if (!accountHash) return;
  try {
    await getStore(STRATEGY_STORE).delete(keyFor(accountHash));
  } catch (err) {
    console.warn(`[strategy-store] delete ${accountHash} failed:`, err);
  }
}

/**
 * Did this account have its own override stored? Used by the engine loop to
 * decide whether targets were customised — useful for digest narrative.
 */
export async function hasServerStrategyOverride(accountHash: string): Promise<boolean> {
  if (!accountHash) return false;
  const raw = await rawGet(keyFor(accountHash));
  return raw != null;
}

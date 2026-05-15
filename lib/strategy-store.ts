/**
 * Server-side strategy targets store.
 *
 * The SettingsPanel persists user-customized allocation targets to localStorage,
 * which is fine for the dashboard UI but invisible to the daily cron and the
 * signal engine (which run server-side and have no browser context).
 *
 * This module mirrors strategy targets to a Netlify Blob so the engine can
 * read what the user actually wants their allocation to look like. The
 * SettingsPanel writes to both localStorage and `/api/strategy` (POST) on
 * save; the engine reads via `getServerStrategyTargets()`.
 *
 * If no server-side record exists yet (e.g. the user hasn't visited the
 * SettingsPanel since this feature shipped), `getServerStrategyTargets()`
 * returns DEFAULT_TARGETS — same fallback the UI uses.
 */

import { getStore } from '@netlify/blobs';
import { DEFAULT_TARGETS, type StrategyTargets } from './utils';

const STRATEGY_STORE = 'strategy-targets';
const STRATEGY_KEY   = 'current';

interface StoredStrategyTargets extends StrategyTargets {
  updatedAt: number;
}

export async function getServerStrategyTargets(): Promise<StrategyTargets> {
  try {
    const stored = (await getStore(STRATEGY_STORE).get(STRATEGY_KEY, {
      type: 'json',
    })) as StoredStrategyTargets | null;
    if (!stored) return { ...DEFAULT_TARGETS };
    // Merge stored over defaults so future schema additions degrade gracefully.
    return { ...DEFAULT_TARGETS, ...stored };
  } catch (err) {
    console.warn('[strategy-store] read failed, using defaults:', err);
    return { ...DEFAULT_TARGETS };
  }
}

export async function saveServerStrategyTargets(t: StrategyTargets): Promise<void> {
  const payload: StoredStrategyTargets = {
    ...DEFAULT_TARGETS,
    ...t,
    updatedAt: Date.now(),
  };
  await getStore(STRATEGY_STORE).setJSON(STRATEGY_KEY, payload);
}

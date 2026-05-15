/**
 * Shared loader: pulls trade-history + trade-inbox + snapshots, builds a
 * recap, and renders the feedback block in one call.
 *
 * Endpoints use this to inject context into Claude prompts without each one
 * re-implementing the data load.
 *
 * Failures are swallowed — feedback context is enrichment, not load-bearing.
 * If the blob reads fail, the prompt simply runs without prior context.
 */

import { getStore } from '@netlify/blobs';
import { listInbox } from '../inbox';
import {
  getCashFlows,
  getLatestPortfolioSnapshot,
  getSnapshotHistory,
} from '../storage';
import { buildRecap, type FullRecap } from '../recap';
import { computeProgressVs40, computeTWR } from '../performance';
import { buildFeedbackBlock } from './feedback-context';
import { buildPaceBlock, type PaceContext } from './pace-context';
import type { TradeHistoryEntry } from '@/app/api/orders/route';

const DEFAULT_OPERATIONAL_WINDOW = 14;

async function loadTradeHistory(): Promise<TradeHistoryEntry[]> {
  try {
    const data = await getStore('trade-history').get('log', { type: 'json' });
    return Array.isArray(data) ? (data as TradeHistoryEntry[]) : [];
  } catch {
    return [];
  }
}

/**
 * Build the operational feedback block (default 14d). Returns null when
 * something fails or there's not enough data — caller treats null as "no
 * feedback available, just run the prompt".
 */
export async function loadFeedbackBlock(lookbackDays = DEFAULT_OPERATIONAL_WINDOW): Promise<string | null> {
  try {
    const [trades, inbox, snapshots, latest] = await Promise.all([
      loadTradeHistory(),
      listInbox(),
      getSnapshotHistory(60),
      getLatestPortfolioSnapshot(),
    ]);
    const recap = buildRecap(trades, inbox, snapshots, latest, lookbackDays);
    return buildFeedbackBlock(recap);
  } catch (err) {
    console.warn('[recap-loader] feedback load failed:', err);
    return null;
  }
}

/**
 * Build the pace context (TWR + CAGR + gap vs 40% target). Returns null if
 * we don't have enough snapshot history (need ≥2) or computation fails.
 *
 * Pulled from full snapshot history so the window reflects the longest
 * measurable horizon — `daysSinceStart` is the actual span between first
 * and last snapshot, not a fixed lookback.
 */
export async function loadPaceContext(): Promise<PaceContext | null> {
  try {
    const [snapshots, cashFlows] = await Promise.all([
      getSnapshotHistory(365),
      getCashFlows(),
    ]);
    // Mirror /api/performance: synthetic snapshots have positions-only equity
    // and would corrupt the TWR. Compute pace from real snapshots only so the
    // AI's pace context agrees with the Performance panel headline.
    const realSnapshots = snapshots.filter((s) => !s.synthetic);
    if (realSnapshots.length < 2) return null;

    const twr = computeTWR(realSnapshots, cashFlows);
    if (!twr) return null;

    const progress = computeProgressVs40(twr.cagrPct, twr.daysCovered);
    return { twr, progress, daysSinceStart: twr.daysCovered };
  } catch (err) {
    console.warn('[recap-loader] pace context load failed:', err);
    return null;
  }
}

/**
 * Same as loadPaceContext but returns the rendered prompt block. Returns
 * null when there's nothing useful to inject — caller skips the block.
 */
export async function loadPaceBlock(): Promise<string | null> {
  const ctx = await loadPaceContext();
  return buildPaceBlock(ctx);
}

/** Same as loadFeedbackBlock but returns the raw recap (for the review panel). */
export async function loadRecap(lookbackDays = 90): Promise<FullRecap | null> {
  try {
    const [trades, inbox, snapshots, latest] = await Promise.all([
      loadTradeHistory(),
      listInbox(),
      getSnapshotHistory(120),
      getLatestPortfolioSnapshot(),
    ]);
    return buildRecap(trades, inbox, snapshots, latest, lookbackDays);
  } catch (err) {
    console.warn('[recap-loader] recap load failed:', err);
    return null;
  }
}

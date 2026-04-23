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
  getLatestPortfolioSnapshot,
  getSnapshotHistory,
} from '../storage';
import { buildRecap, type FullRecap } from '../recap';
import { buildFeedbackBlock } from './feedback-context';
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

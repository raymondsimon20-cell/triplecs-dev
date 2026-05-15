/**
 * Storage abstraction layer — Netlify Blobs (production).
 * For local dev, tokens are stored in .data/ via the Netlify CLI dev server
 * which emulates Blobs locally. Run: `netlify dev` instead of `npm run dev`.
 */

import { getStore } from '@netlify/blobs';
import type { SchwabTokens } from './schwab/types';

// ─── Token storage ────────────────────────────────────────────────────────────

export async function saveTokens(tokens: SchwabTokens): Promise<void> {
  await getStore('schwab-tokens').setJSON('current-user', tokens);
}

export async function getTokens(): Promise<SchwabTokens | null> {
  return getStore('schwab-tokens').get('current-user', { type: 'json' });
}

export async function deleteTokens(): Promise<void> {
  await getStore('schwab-tokens').delete('current-user');
}

export async function hasTokens(): Promise<boolean> {
  const t = await getTokens();
  return t !== null;
}

// ─── Portfolio cache ──────────────────────────────────────────────────────────

interface CachedPortfolio {
  data: unknown;
  cachedAt: number;
}

export async function cachePortfolio(accountNumber: string, data: unknown): Promise<void> {
  await getStore('portfolio-cache').setJSON(`portfolio-${accountNumber}`, {
    data,
    cachedAt: Date.now(),
  } satisfies CachedPortfolio);
}

export async function getCachedPortfolio(
  accountNumber: string,
  maxAgeMs = 60_000,
): Promise<unknown | null> {
  const cached = await getStore('portfolio-cache').get(
    `portfolio-${accountNumber}`,
    { type: 'json' },
  ) as CachedPortfolio | null;
  if (!cached) return null;
  if (Date.now() - cached.cachedAt > maxAgeMs) return null;
  return cached.data;
}

// ─── AI Analysis history ──────────────────────────────────────────────────────

export interface AnalysisRecord {
  id: string;
  createdAt: number;
  accountHash: string;
  prompt: string;
  analysis: string;
}

export async function saveAnalysis(record: AnalysisRecord): Promise<void> {
  await getStore('ai-analysis').setJSON(`analysis-${record.id}`, record);
}

export async function listAnalyses(accountHash: string): Promise<AnalysisRecord[]> {
  const store = getStore('ai-analysis');
  const { blobs } = await store.list({ prefix: 'analysis-' });
  const records = await Promise.all(
    blobs.map((b) => store.get(b.key, { type: 'json' }) as Promise<AnalysisRecord>)
  );
  return records
    .filter((r): r is AnalysisRecord => r !== null && r.accountHash === accountHash)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 20);
}

// ─── Portfolio snapshots ──────────────────────────────────────────────────────

export interface PortfolioSnapshot {
  savedAt: number;
  totalValue: number;
  equity: number;
  marginBalance: number;
  marginUtilizationPct: number;
  pillarSummary: Array<{
    pillar: string;
    portfolioPercent: number;
    totalValue: number;
  }>;
  positions: Array<{
    symbol: string;
    pillar: string;
    marketValue: number;
    shares: number;
    unrealizedGL: number;
    /**
     * Fund family + maintenance metadata populated from `lib/data/fund-metadata.ts`.
     * Optional so historical snapshots written before Phase 1 still deserialize.
     */
    family?: string;
    maintenancePct?: number;
    maintenancePctSource?: 'explicit' | 'default';
  }>;
  /** SPY closing price on the snapshot date — used as benchmark for alpha calc. */
  spyClose?: number;
  /**
   * AFW (Available For Withdrawal) dollars at snapshot time. Schwab's
   * margin-headroom metric. Optional so historical snapshots written before
   * AFW capture shipped continue to deserialize. Enables future backtest /
   * replay paths to gate AFW-aware rules against true headroom.
   */
  afwDollars?: number;
  /** True when the snapshot was reconstructed by the backfill routine, not captured live. */
  synthetic?: boolean;
}

export async function savePortfolioSnapshot(snapshot: PortfolioSnapshot): Promise<void> {
  const store = getStore('portfolio-snapshots');
  // Save both 'latest' (for AI context) and a date-keyed entry (for chart history)
  const dayKey = `day-${new Date(snapshot.savedAt).toISOString().slice(0, 10)}`;
  // Synthetic backfill writes never clobber a real snapshot for the same day.
  if (snapshot.synthetic) {
    const existing = await store.get(dayKey, { type: 'json' }) as PortfolioSnapshot | null;
    if (existing && !existing.synthetic) return;
    await store.setJSON(dayKey, snapshot);
    return;
  }
  await Promise.all([
    store.setJSON('latest', snapshot),
    store.setJSON(dayKey, snapshot),
  ]);
}

export async function getLatestPortfolioSnapshot(): Promise<PortfolioSnapshot | null> {
  return getStore('portfolio-snapshots').get('latest', { type: 'json' });
}

/** Returns up to `limit` daily snapshots sorted newest-first. */
export async function getSnapshotHistory(limit = 90): Promise<PortfolioSnapshot[]> {
  const store  = getStore('portfolio-snapshots');
  const { blobs } = await store.list({ prefix: 'day-' });
  const sorted = blobs
    .map((b) => b.key)
    .sort()          // lexicographic = chronological for YYYY-MM-DD keys
    .reverse()
    .slice(0, limit);
  const records = await Promise.all(
    sorted.map((key) => store.get(key, { type: 'json' }) as Promise<PortfolioSnapshot | null>)
  );
  return records.filter((r): r is PortfolioSnapshot => r !== null);
}

// ─── Cash-flow events (for TWR calculation) ──────────────────────────────────

/**
 * A capital movement that crosses the account boundary — money in or out.
 * Used to segment time-weighted return so deposits/withdrawals don't get
 * counted as portfolio performance.
 *
 * `direction`: 'in' for deposits / journals received / dividend cash credit,
 * 'out' for withdrawals / journals sent / margin interest / fees.
 *
 * `amount` is always positive; sign is encoded in `direction`.
 */
export interface CashFlowEvent {
  id: string;                 // stable id from Schwab activityId, or synthetic
  date: string;               // YYYY-MM-DD (event date, normalised)
  direction: 'in' | 'out';
  amount: number;             // positive number, USD
  kind: 'deposit' | 'withdrawal' | 'journal' | 'dividend' | 'interest' | 'fee' | 'other';
  description?: string;
  source: 'schwab' | 'manual';
  /** Original Schwab activityId, when available — used for de-dupe. */
  activityId?: string;
}

const CASH_FLOWS_KEY = 'log';

export async function getCashFlows(): Promise<CashFlowEvent[]> {
  const data = await getStore('cash-flows').get(CASH_FLOWS_KEY, { type: 'json' });
  return Array.isArray(data) ? data : [];
}

/**
 * Append new cash-flow events. De-dupes on `id` (and `activityId` if present)
 * so re-running the daily sync is idempotent.
 */
export async function appendCashFlows(events: CashFlowEvent[]): Promise<number> {
  if (events.length === 0) return 0;
  const existing = await getCashFlows();
  const seenIds = new Set(existing.map((e) => e.id));
  const seenActivity = new Set(
    existing.map((e) => e.activityId).filter((x): x is string => Boolean(x)),
  );
  const fresh = events.filter((e) => {
    if (seenIds.has(e.id)) return false;
    if (e.activityId && seenActivity.has(e.activityId)) return false;
    return true;
  });
  if (fresh.length === 0) return 0;
  const merged = [...existing, ...fresh].sort((a, b) => a.date.localeCompare(b.date));
  await getStore('cash-flows').setJSON(CASH_FLOWS_KEY, merged);
  return fresh.length;
}

// ─── Recommendation tracking ──────────────────────────────────────────────────

export interface TrackedRecommendation {
  id: string;
  savedAt: number;
  mode: string;
  action: string;
  ticker: string;
  rationale: string;
  urgency: string;
  dollarAmount: number | null;
  sellPct: number | null;
  status: 'pending' | 'executed' | 'skipped';
  executedAt?: number;
}

export async function saveRecommendations(recs: TrackedRecommendation[]): Promise<void> {
  const existing = await getRecommendations();
  const merged = [...recs, ...existing].slice(0, 100);
  await getStore('recommendations').setJSON('history', merged);
}

export async function getRecommendations(): Promise<TrackedRecommendation[]> {
  const data = await getStore('recommendations').get('history', { type: 'json' });
  return Array.isArray(data) ? data : [];
}

export async function updateRecommendationStatus(
  id: string,
  status: 'executed' | 'skipped',
): Promise<void> {
  const recs = await getRecommendations();
  const updated = recs.map((r) =>
    r.id === id ? { ...r, status, executedAt: Date.now() } : r,
  );
  await getStore('recommendations').setJSON('history', updated);
}

// ─── Proactive alerts ─────────────────────────────────────────────────────────

export interface StoredAlert {
  id: string;
  createdAt: number;
  level: 'danger' | 'warn' | 'ok';
  rule: string;
  detail: string;
  read: boolean;
}

export async function saveAlerts(alerts: StoredAlert[]): Promise<void> {
  await getStore('alerts').setJSON('current', alerts);
}

export async function getAlerts(): Promise<StoredAlert[]> {
  const data = await getStore('alerts').get('current', { type: 'json' });
  return Array.isArray(data) ? data : [];
}

export async function markAlertsRead(): Promise<void> {
  const alerts = await getAlerts();
  await saveAlerts(alerts.map((a) => ({ ...a, read: true })));
}

// ─── Cornerstone NAV snapshot (for daily-alert premium check) ────────────────

export interface CornerstoneNavSnapshot {
  savedAt: number;
  funds: Array<{ ticker: string; nav: number; marketPrice: number; premiumDiscount: number }>;
}

export async function saveCornerstoneSnapshot(snap: CornerstoneNavSnapshot): Promise<void> {
  await getStore('cornerstone-nav-snapshot').setJSON('latest', snap);
}

export async function getCornerstoneSnapshot(): Promise<CornerstoneNavSnapshot | null> {
  return getStore('cornerstone-nav-snapshot').get('latest', { type: 'json' });
}

// ─── User expenses ────────────────────────────────────────────────────────────

export async function saveUserExpenses(expenses: unknown[]): Promise<void> {
  await getStore('user-expenses').setJSON('expenses', expenses);
}

export async function getUserExpenses(): Promise<unknown[]> {
  const data = await getStore('user-expenses').get('expenses', { type: 'json' });
  return Array.isArray(data) ? data : [];
}

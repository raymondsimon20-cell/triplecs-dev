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
  }>;
}

export async function savePortfolioSnapshot(snapshot: PortfolioSnapshot): Promise<void> {
  const store = getStore('portfolio-snapshots');
  // Save both 'latest' (for AI context) and a date-keyed entry (for chart history)
  const dayKey = `day-${new Date(snapshot.savedAt).toISOString().slice(0, 10)}`;
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

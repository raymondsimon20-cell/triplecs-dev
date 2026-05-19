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

/** Same retention used by per-account snapshots — household keeps the
 *  rolling 365-day window so blob storage doesn't grow forever. */
const HOUSEHOLD_SNAPSHOT_RETENTION_DAYS = 365;

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

  // Best-effort retention sweep — mirrors savePerAccountSnapshot. Without
  // this the household day-keys grew forever (per-account had a sweep but
  // the household path was missed). Failures don't poison the write.
  try {
    const { blobs } = await store.list({ prefix: 'day-' });
    if (blobs.length > HOUSEHOLD_SNAPSHOT_RETENTION_DAYS) {
      const dropped = blobs
        .map((b) => b.key)
        .sort()                                 // YYYY-MM-DD lexicographic
        .slice(0, blobs.length - HOUSEHOLD_SNAPSHOT_RETENTION_DAYS);
      await Promise.all(dropped.map((k) => store.delete(k).catch(() => undefined)));
    }
  } catch (err) {
    console.warn('[storage] household snapshot retention sweep failed:', err);
  }
}

/**
 * 2026-05 per-account snapshots. Stored at `account:{hash}:latest` and
 * `account:{hash}:day-YYYY-MM-DD`. Used by the per-account performance
 * panels and by per-account circuit breakers (drawdown reference). The
 * household-level snapshot (above) continues to be written for legacy
 * consumers that don't yet split by account.
 *
 * Retention: keep the most recent {@link PER_ACCOUNT_SNAPSHOT_RETENTION_DAYS}
 * day-keyed snapshots per account; older ones are deleted on each write.
 */
const PER_ACCOUNT_SNAPSHOT_RETENTION_DAYS = 365;

export async function savePerAccountSnapshot(
  accountHash: string,
  snapshot: PortfolioSnapshot,
): Promise<void> {
  if (!accountHash) return;
  const store  = getStore('portfolio-snapshots');
  const latestKey = `account:${accountHash}:latest`;
  const dayKey    = `account:${accountHash}:day-${new Date(snapshot.savedAt).toISOString().slice(0, 10)}`;
  if (snapshot.synthetic) {
    const existing = await store.get(dayKey, { type: 'json' }) as PortfolioSnapshot | null;
    if (existing && !existing.synthetic) return;
    await store.setJSON(dayKey, snapshot);
    return;
  }
  await Promise.all([
    store.setJSON(latestKey, snapshot),
    store.setJSON(dayKey, snapshot),
  ]);

  // Best-effort retention: drop day-keys outside the rolling window so blob
  // storage doesn't grow without bound. Failures don't poison the write.
  try {
    const prefix = `account:${accountHash}:day-`;
    const { blobs } = await store.list({ prefix });
    if (blobs.length > PER_ACCOUNT_SNAPSHOT_RETENTION_DAYS) {
      const dropped = blobs
        .map((b) => b.key)
        .sort()                                 // YYYY-MM-DD lexicographic
        .slice(0, blobs.length - PER_ACCOUNT_SNAPSHOT_RETENTION_DAYS);
      await Promise.all(dropped.map((k) => store.delete(k).catch(() => undefined)));
    }
  } catch (err) {
    console.warn(`[storage] per-account snapshot retention sweep failed for ${accountHash.slice(0, 6)}…:`, err);
  }
}

export async function getLatestPortfolioSnapshot(accountHash?: string): Promise<PortfolioSnapshot | null> {
  const store = getStore('portfolio-snapshots');
  if (accountHash) {
    const own = await store.get(`account:${accountHash}:latest`, { type: 'json' }) as PortfolioSnapshot | null;
    if (own) return own;
    // Fall back to household snapshot for accounts with no per-account
    // history yet. Better than nothing for AI-context preambles.
  }
  return store.get('latest', { type: 'json' });
}

/** Returns up to `limit` daily snapshots sorted newest-first. With an
 *  accountHash, returns per-account snapshots (falling back to household
 *  snapshots if none exist for this account yet). */
export async function getSnapshotHistory(limit = 90, accountHash?: string): Promise<PortfolioSnapshot[]> {
  const store  = getStore('portfolio-snapshots');
  const prefix = accountHash ? `account:${accountHash}:day-` : 'day-';
  const { blobs } = await store.list({ prefix });
  if (blobs.length === 0 && accountHash) {
    // No per-account history yet — fall back to household snapshots so
    // performance panels show *something* instead of an empty chart.
    return getSnapshotHistory(limit);
  }
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
  /**
   * 2026-05 per-account autopilot. Schwab account hash this event was
   * recorded against. Used by per-account TWR / CAGR calculations so a
   * deposit into the Roth doesn't get counted against the taxable's return.
   * Optional for backward compat with events written before this field
   * shipped.
   */
  accountHash?: string;
}

const CASH_FLOWS_KEY = 'log';

/**
 * Read every recorded cash flow. With an `accountHash`, returns only events
 * tagged with that hash PLUS events with no accountHash (legacy events
 * pre-tagging — included to avoid orphaning history when callers scope by
 * account). Without an accountHash, returns every event (household total).
 */
export async function getCashFlows(accountHash?: string): Promise<CashFlowEvent[]> {
  const data = await getStore('cash-flows').get(CASH_FLOWS_KEY, { type: 'json' });
  const all  = Array.isArray(data) ? (data as CashFlowEvent[]) : [];
  if (!accountHash) return all;
  return all.filter((e) => !e.accountHash || e.accountHash === accountHash);
}

/**
 * Append new cash-flow events. De-dupes three ways so the daily sync is
 * idempotent even when Schwab's response shape shifts subtly across runs:
 *   - exact `id` match (synthetic or Schwab-provided)
 *   - `activityId` match (catches re-fetches where the synthetic id changed
 *      but Schwab is now returning an activityId for the same event)
 *   - fingerprint match: `(accountHash | "" )-date-kind-amount-direction`
 *      (catches the same deposit returned with a tweaked description or
 *      slightly different synthetic key shape — TWR/CAGR doubled otherwise)
 */
function fingerprintEvent(e: CashFlowEvent): string {
  return [
    e.accountHash ?? '',
    e.date,
    e.kind,
    e.amount,
    e.direction,
  ].join('|');
}

export async function appendCashFlows(events: CashFlowEvent[]): Promise<number> {
  if (events.length === 0) return 0;
  // Plain read-modify-write — see mutateInbox note for why we backed out the
  // blob-lock pattern (self-deadlocks against Netlify Blobs eventual
  // consistency). The triple dedup below (id + activityId + fingerprint) is
  // what actually prevents double-counting under the realistic concurrency.
  const existing = await getCashFlows();
  const seenIds = new Set(existing.map((e) => e.id));
  const seenActivity = new Set(
    existing.map((e) => e.activityId).filter((x): x is string => Boolean(x)),
  );
  const seenFingerprints = new Set(existing.map(fingerprintEvent));
  const fresh = events.filter((e) => {
    if (seenIds.has(e.id)) return false;
    if (e.activityId && seenActivity.has(e.activityId)) return false;
    if (seenFingerprints.has(fingerprintEvent(e))) return false;
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
  /**
   * 2026-05 per-account autopilot. Schwab account hash the recommendation
   * was generated against. Optional for backward compat with entries
   * written before this field shipped.
   */
  accountHash?: string;
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
  /**
   * 2026-05 per-account autopilot. Schwab account hash this alert refers to.
   * Optional for backward compat with alerts written before this field
   * shipped + for household-level alerts (e.g. cron health) that aren't
   * scoped to a single account.
   */
  accountHash?: string;
}

export async function saveAlerts(alerts: StoredAlert[]): Promise<void> {
  await getStore('alerts').setJSON('current', alerts);
}

/**
 * Read every stored alert. With an `accountHash`, returns alerts tagged for
 * that account PLUS untagged household-level alerts (e.g. cron health), so a
 * per-account view still sees household-wide warnings.
 */
export async function getAlerts(accountHash?: string): Promise<StoredAlert[]> {
  const data = await getStore('alerts').get('current', { type: 'json' });
  const all  = Array.isArray(data) ? (data as StoredAlert[]) : [];
  if (!accountHash) return all;
  return all.filter((a) => !a.accountHash || a.accountHash === accountHash);
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

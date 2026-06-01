"use strict";
/**
 * Storage abstraction layer — Netlify Blobs (production).
 * For local dev, tokens are stored in .data/ via the Netlify CLI dev server
 * which emulates Blobs locally. Run: `netlify dev` instead of `npm run dev`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.saveTokens = saveTokens;
exports.getTokens = getTokens;
exports.deleteTokens = deleteTokens;
exports.hasTokens = hasTokens;
exports.cachePortfolio = cachePortfolio;
exports.getCachedPortfolio = getCachedPortfolio;
exports.saveAnalysis = saveAnalysis;
exports.listAnalyses = listAnalyses;
exports.savePortfolioSnapshot = savePortfolioSnapshot;
exports.savePerAccountSnapshot = savePerAccountSnapshot;
exports.getLatestPortfolioSnapshot = getLatestPortfolioSnapshot;
exports.getSnapshotHistory = getSnapshotHistory;
exports.getCashFlows = getCashFlows;
exports.appendCashFlows = appendCashFlows;
exports.saveRecommendations = saveRecommendations;
exports.getRecommendations = getRecommendations;
exports.updateRecommendationStatus = updateRecommendationStatus;
exports.saveAlerts = saveAlerts;
exports.getAlerts = getAlerts;
exports.markAlertsRead = markAlertsRead;
exports.saveCornerstoneSnapshot = saveCornerstoneSnapshot;
exports.getCornerstoneSnapshot = getCornerstoneSnapshot;
exports.saveUserExpenses = saveUserExpenses;
exports.getUserExpenses = getUserExpenses;
const blobs_1 = require("@netlify/blobs");
// ─── Token storage ────────────────────────────────────────────────────────────
async function saveTokens(tokens) {
    await (0, blobs_1.getStore)('schwab-tokens').setJSON('current-user', tokens);
}
async function getTokens() {
    return (0, blobs_1.getStore)('schwab-tokens').get('current-user', { type: 'json' });
}
async function deleteTokens() {
    await (0, blobs_1.getStore)('schwab-tokens').delete('current-user');
}
async function hasTokens() {
    const t = await getTokens();
    return t !== null;
}
async function cachePortfolio(accountNumber, data) {
    await (0, blobs_1.getStore)('portfolio-cache').setJSON(`portfolio-${accountNumber}`, {
        data,
        cachedAt: Date.now(),
    });
}
async function getCachedPortfolio(accountNumber, maxAgeMs = 60000) {
    const cached = await (0, blobs_1.getStore)('portfolio-cache').get(`portfolio-${accountNumber}`, { type: 'json' });
    if (!cached)
        return null;
    if (Date.now() - cached.cachedAt > maxAgeMs)
        return null;
    return cached.data;
}
async function saveAnalysis(record) {
    await (0, blobs_1.getStore)('ai-analysis').setJSON(`analysis-${record.id}`, record);
}
async function listAnalyses(accountHash) {
    const store = (0, blobs_1.getStore)('ai-analysis');
    const { blobs } = await store.list({ prefix: 'analysis-' });
    const records = await Promise.all(blobs.map((b) => store.get(b.key, { type: 'json' })));
    return records
        .filter((r) => r !== null && r.accountHash === accountHash)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 20);
}
/** Same retention used by per-account snapshots — household keeps the
 *  rolling 365-day window so blob storage doesn't grow forever. */
const HOUSEHOLD_SNAPSHOT_RETENTION_DAYS = 365;
async function savePortfolioSnapshot(snapshot) {
    const store = (0, blobs_1.getStore)('portfolio-snapshots');
    // Save both 'latest' (for AI context) and a date-keyed entry (for chart history)
    const dayKey = `day-${new Date(snapshot.savedAt).toISOString().slice(0, 10)}`;
    // Synthetic backfill writes never clobber a real snapshot for the same day.
    if (snapshot.synthetic) {
        const existing = await store.get(dayKey, { type: 'json' });
        if (existing && !existing.synthetic)
            return;
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
                .sort() // YYYY-MM-DD lexicographic
                .slice(0, blobs.length - HOUSEHOLD_SNAPSHOT_RETENTION_DAYS);
            await Promise.all(dropped.map((k) => store.delete(k).catch(() => undefined)));
        }
    }
    catch (err) {
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
async function savePerAccountSnapshot(accountHash, snapshot) {
    if (!accountHash)
        return;
    const store = (0, blobs_1.getStore)('portfolio-snapshots');
    const latestKey = `account:${accountHash}:latest`;
    const dayKey = `account:${accountHash}:day-${new Date(snapshot.savedAt).toISOString().slice(0, 10)}`;
    if (snapshot.synthetic) {
        const existing = await store.get(dayKey, { type: 'json' });
        if (existing && !existing.synthetic)
            return;
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
                .sort() // YYYY-MM-DD lexicographic
                .slice(0, blobs.length - PER_ACCOUNT_SNAPSHOT_RETENTION_DAYS);
            await Promise.all(dropped.map((k) => store.delete(k).catch(() => undefined)));
        }
    }
    catch (err) {
        console.warn(`[storage] per-account snapshot retention sweep failed for ${accountHash.slice(0, 6)}…:`, err);
    }
}
async function getLatestPortfolioSnapshot(accountHash) {
    const store = (0, blobs_1.getStore)('portfolio-snapshots');
    if (accountHash) {
        const own = await store.get(`account:${accountHash}:latest`, { type: 'json' });
        if (own)
            return own;
        // Fall back to household snapshot for accounts with no per-account
        // history yet. Better than nothing for AI-context preambles.
    }
    return store.get('latest', { type: 'json' });
}
/** Returns up to `limit` daily snapshots sorted newest-first. With an
 *  accountHash, returns per-account snapshots (falling back to household
 *  snapshots if none exist for this account yet). */
async function getSnapshotHistory(limit = 90, accountHash) {
    const store = (0, blobs_1.getStore)('portfolio-snapshots');
    const prefix = accountHash ? `account:${accountHash}:day-` : 'day-';
    const { blobs } = await store.list({ prefix });
    if (blobs.length === 0 && accountHash) {
        // No per-account history yet — fall back to household snapshots so
        // performance panels show *something* instead of an empty chart.
        return getSnapshotHistory(limit);
    }
    const sorted = blobs
        .map((b) => b.key)
        .sort() // lexicographic = chronological for YYYY-MM-DD keys
        .reverse()
        .slice(0, limit);
    const records = await Promise.all(sorted.map((key) => store.get(key, { type: 'json' })));
    return records.filter((r) => r !== null);
}
const CASH_FLOWS_KEY = 'log';
/**
 * Read every recorded cash flow. With an `accountHash`, returns only events
 * tagged with that hash PLUS events with no accountHash (legacy events
 * pre-tagging — included to avoid orphaning history when callers scope by
 * account). Without an accountHash, returns every event (household total).
 */
async function getCashFlows(accountHash) {
    const data = await (0, blobs_1.getStore)('cash-flows').get(CASH_FLOWS_KEY, { type: 'json' });
    const all = Array.isArray(data) ? data : [];
    if (!accountHash)
        return all;
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
function fingerprintEvent(e) {
    return [
        e.accountHash ?? '',
        e.date,
        e.kind,
        e.amount,
        e.direction,
    ].join('|');
}
async function appendCashFlows(events) {
    if (events.length === 0)
        return 0;
    // Plain read-modify-write — see mutateInbox note for why we backed out the
    // blob-lock pattern (self-deadlocks against Netlify Blobs eventual
    // consistency). The triple dedup below (id + activityId + fingerprint) is
    // what actually prevents double-counting under the realistic concurrency.
    const existing = await getCashFlows();
    const seenIds = new Set(existing.map((e) => e.id));
    const seenActivity = new Set(existing.map((e) => e.activityId).filter((x) => Boolean(x)));
    const seenFingerprints = new Set(existing.map(fingerprintEvent));
    const fresh = events.filter((e) => {
        if (seenIds.has(e.id))
            return false;
        if (e.activityId && seenActivity.has(e.activityId))
            return false;
        if (seenFingerprints.has(fingerprintEvent(e)))
            return false;
        return true;
    });
    if (fresh.length === 0)
        return 0;
    const merged = [...existing, ...fresh].sort((a, b) => a.date.localeCompare(b.date));
    await (0, blobs_1.getStore)('cash-flows').setJSON(CASH_FLOWS_KEY, merged);
    return fresh.length;
}
async function saveRecommendations(recs) {
    const existing = await getRecommendations();
    const merged = [...recs, ...existing].slice(0, 100);
    await (0, blobs_1.getStore)('recommendations').setJSON('history', merged);
}
async function getRecommendations() {
    const data = await (0, blobs_1.getStore)('recommendations').get('history', { type: 'json' });
    return Array.isArray(data) ? data : [];
}
async function updateRecommendationStatus(id, status) {
    const recs = await getRecommendations();
    const updated = recs.map((r) => r.id === id ? { ...r, status, executedAt: Date.now() } : r);
    await (0, blobs_1.getStore)('recommendations').setJSON('history', updated);
}
async function saveAlerts(alerts) {
    await (0, blobs_1.getStore)('alerts').setJSON('current', alerts);
}
/**
 * Read every stored alert. With an `accountHash`, returns alerts tagged for
 * that account PLUS untagged household-level alerts (e.g. cron health), so a
 * per-account view still sees household-wide warnings.
 */
async function getAlerts(accountHash) {
    const data = await (0, blobs_1.getStore)('alerts').get('current', { type: 'json' });
    const all = Array.isArray(data) ? data : [];
    if (!accountHash)
        return all;
    return all.filter((a) => !a.accountHash || a.accountHash === accountHash);
}
async function markAlertsRead() {
    const alerts = await getAlerts();
    await saveAlerts(alerts.map((a) => ({ ...a, read: true })));
}
async function saveCornerstoneSnapshot(snap) {
    await (0, blobs_1.getStore)('cornerstone-nav-snapshot').setJSON('latest', snap);
}
async function getCornerstoneSnapshot() {
    return (0, blobs_1.getStore)('cornerstone-nav-snapshot').get('latest', { type: 'json' });
}
// ─── User expenses ────────────────────────────────────────────────────────────
async function saveUserExpenses(expenses) {
    await (0, blobs_1.getStore)('user-expenses').setJSON('expenses', expenses);
}
async function getUserExpenses() {
    const data = await (0, blobs_1.getStore)('user-expenses').get('expenses', { type: 'json' });
    return Array.isArray(data) ? data : [];
}

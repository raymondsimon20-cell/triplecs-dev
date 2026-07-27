import { NextResponse } from 'next/server';
import { getStore } from '@netlify/blobs';
import { requireAuth } from '@/lib/session';
import { createClient, getAccountNumbers, getPriceHistory } from '@/lib/schwab/client';
import { getTokens } from '@/lib/storage';
import { getFundMetadata, getFallbackYieldPct } from '@/lib/data/fund-metadata';

export const dynamic = 'force-dynamic';

/**
 * GET /api/target-allocation — per-ticker metrics for the Target Allocation
 * tool (Tools → Allocation).
 *
 * Serves raw metrics only; scoring/signals/calculator live client-side so
 * thresholds can be tuned without a redeploy. Universe = real positions
 * (market value ≥ $500) — 1-share seeds are universe bookmarks and are never
 * scored (seed-universe convention).
 *
 * Metrics per ticker: price, shares, value, pillar, SMA50 + % vs, 12/24-month
 * price return, distribution yield (live divYield ?? fallback table), margin
 * maintenance %.
 *
 * Price-history calls are chunked (5 at a time) and the whole payload is
 * cached in Blobs for 30 minutes per account scope.
 */

const SEED_MAX_DOLLARS = 500;
const CACHE_STORE = 'target-alloc';
const CACHE_TTL_MS = 30 * 60 * 1000;

export interface AllocationRow {
  symbol:         string;
  pillar:         string;
  family:         string;
  shares:         number;
  price:          number;
  marketValue:    number;
  sma50:          number | null;
  vsSma50Pct:     number | null;
  /** Price return %, trailing ~12 / ~24 months (null when history is short). */
  ret12Pct:       number | null;
  ret24Pct:       number | null;
  yieldPct:       number;
  yieldSource:    'live' | 'fallback' | 'none';
  maintenancePct: number;
}

function pctChange(from: number, to: number): number | null {
  if (!Number.isFinite(from) || from <= 0) return null;
  return ((to - from) / from) * 100;
}

/** Close nearest to `daysAgo` calendar days back (candles are chronological). */
function closeNear(candles: { datetime: number; close: number }[], daysAgo: number): number | null {
  if (candles.length === 0) return null;
  const target = Date.now() - daysAgo * 24 * 60 * 60 * 1000;
  let best: { dist: number; close: number } | null = null;
  for (const c of candles) {
    const dist = Math.abs(c.datetime - target);
    if (!best || dist < best.dist) best = { dist, close: c.close };
  }
  // Reject matches more than 30 days off-target — history too short.
  return best && best.dist < 30 * 24 * 60 * 60 * 1000 ? best.close : null;
}

export async function GET(req: Request) {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const accountHashParam = searchParams.get('accountHash') ?? 'all';
  const cacheKey = `rows-${accountHashParam}`;

  // Serve fresh-enough cache.
  try {
    const cached = await getStore(CACHE_STORE).get(cacheKey, { type: 'json' }) as
      | { generatedAt: number; rows: AllocationRow[] } | null;
    if (cached && Date.now() - cached.generatedAt < CACHE_TTL_MS && !searchParams.get('refresh')) {
      return NextResponse.json({ ...cached, cached: true });
    }
  } catch { /* cache miss is fine */ }

  try {
    const tokens = await getTokens();
    if (!tokens) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    const client = await createClient();
    const allAccounts = await getAccountNumbers(tokens);
    const scoped = accountHashParam !== 'all'
      ? allAccounts.filter((a) => a.hashValue === accountHashParam)
      : allAccounts;
    if (!scoped.length) return NextResponse.json({ rows: [], generatedAt: Date.now() });

    // Aggregate positions across scope; skip options + sub-$500 seeds.
    const bySymbol = new Map<string, { shares: number; marketValue: number }>();
    for (const { hashValue } of scoped) {
      const wrapper = await client.getAccount(hashValue);
      for (const p of wrapper.securitiesAccount?.positions ?? []) {
        const sym = p.instrument?.symbol ?? '';
        if (!sym || sym.includes(' ') || p.instrument?.assetType === 'OPTION') continue;
        if ((p.longQuantity ?? 0) <= 0) continue;
        const prev = bySymbol.get(sym) ?? { shares: 0, marketValue: 0 };
        prev.shares      += p.longQuantity ?? 0;
        prev.marketValue += p.marketValue ?? 0;
        bySymbol.set(sym, prev);
      }
    }
    const universe = [...bySymbol.entries()]
      .filter(([, v]) => v.marketValue >= SEED_MAX_DOLLARS)
      .map(([sym]) => sym);

    // Quotes: price + live divYield.
    const quotes = await client.getQuotes(universe);

    // Price history: ~25 months of daily candles, chunked to be polite.
    const to   = new Date().toISOString().split('T')[0];
    const from = new Date(Date.now() - 25 * 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const freshTokens = await getTokens();
    const histories = new Map<string, { datetime: number; close: number }[]>();
    for (let i = 0; i < universe.length; i += 5) {
      const chunk = universe.slice(i, i + 5);
      await Promise.all(chunk.map(async (sym) => {
        try {
          const candles = await getPriceHistory(freshTokens!, sym, from, to);
          histories.set(sym, candles.map((c) => ({ datetime: c.datetime, close: c.close })));
        } catch (err) {
          console.warn(`[TargetAlloc] history failed for ${sym}:`, err);
          histories.set(sym, []);
        }
      }));
    }

    const rows: AllocationRow[] = universe.map((sym) => {
      const pos     = bySymbol.get(sym)!;
      const q       = quotes[sym]?.quote;
      const price   = q?.lastPrice ?? q?.mark ?? (pos.shares > 0 ? pos.marketValue / pos.shares : 0);
      const candles = histories.get(sym) ?? [];
      const closes  = candles.map((c) => c.close);
      const sma50   = closes.length >= 50
        ? closes.slice(-50).reduce((s, v) => s + v, 0) / 50
        : null;

      const liveYield = q?.divYield;
      const fb = getFallbackYieldPct(sym);
      const yieldPct = (typeof liveYield === 'number' && liveYield > 0) ? liveYield : (fb ?? 0);
      const yieldSource: AllocationRow['yieldSource'] =
        (typeof liveYield === 'number' && liveYield > 0) ? 'live' : fb ? 'fallback' : 'none';

      const meta = getFundMetadata(sym);
      const c12 = closeNear(candles, 365);
      const c24 = closeNear(candles, 730);

      return {
        symbol:         sym,
        pillar:         meta?.pillar ?? 'other',
        family:         meta?.family ?? 'Other',
        shares:         pos.shares,
        price,
        marketValue:    pos.marketValue,
        sma50:          sma50 !== null ? Math.round(sma50 * 100) / 100 : null,
        vsSma50Pct:     sma50 !== null && price > 0 ? Math.round(((price / sma50) - 1) * 10_000) / 100 : null,
        ret12Pct:       c12 !== null ? Math.round((pctChange(c12, price) ?? 0) * 100) / 100 : null,
        ret24Pct:       c24 !== null ? Math.round((pctChange(c24, price) ?? 0) * 100) / 100 : null,
        yieldPct:       Math.round(yieldPct * 100) / 100,
        yieldSource,
        maintenancePct: meta?.maintenancePct ?? 60,
      };
    });

    const payload = { rows, generatedAt: Date.now() };
    try { await getStore(CACHE_STORE).setJSON(cacheKey, payload); } catch { /* non-fatal */ }
    return NextResponse.json(payload);
  } catch (err) {
    console.error('[TargetAlloc API]', err);
    return NextResponse.json({ error: 'Failed to compute allocation metrics' }, { status: 500 });
  }
}

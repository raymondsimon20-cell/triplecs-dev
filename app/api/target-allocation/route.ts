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
 * Scores the FULL equity universe including 1-share seeds (they're scale-up
 * candidates — scoring them for ADD decisions is the point; the client keeps
 * them exempt from Trim signals per the seed convention).
 *
 * 160+ price-history calls can't fit in one serverless invocation, so history
 * metrics warm progressively: each request computes up to HISTORY_BUDGET
 * missing/stale symbols (chunked), persists them into a single blob map with
 * a ~20h TTL (daily candles change daily), and reports `pending` — the count
 * still un-warmed. The client re-polls until pending reaches zero; after the
 * first warm-up, requests are served entirely from the map.
 */

const HIST_STORE     = 'target-alloc';
const HIST_KEY       = 'hist-map';
const HIST_TTL_MS    = 20 * 60 * 60 * 1000;
const HISTORY_BUDGET = 40;   // per-request history fetches
const CHUNK          = 10;   // parallel history calls per wave
const QUOTE_CHUNK    = 50;

export interface AllocationRow {
  symbol:         string;
  pillar:         string;
  family:         string;
  shares:         number;
  price:          number;
  marketValue:    number;
  isSeed:         boolean;
  sma50:          number | null;
  vsSma50Pct:     number | null;
  ret12Pct:       number | null;
  ret24Pct:       number | null;
  yieldPct:       number;
  yieldSource:    'live' | 'fallback' | 'none';
  maintenancePct: number;
  /** History metrics not warmed yet — SMA/returns are null this round. */
  pending:        boolean;
}

interface HistMetric { ts: number; sma50: number | null; c12: number | null; c24: number | null }

const SEED_MAX_DOLLARS = 500;

function closeNear(candles: { datetime: number; close: number }[], daysAgo: number): number | null {
  if (candles.length === 0) return null;
  const target = Date.now() - daysAgo * 24 * 60 * 60 * 1000;
  let best: { dist: number; close: number } | null = null;
  for (const c of candles) {
    const dist = Math.abs(c.datetime - target);
    if (!best || dist < best.dist) best = { dist, close: c.close };
  }
  return best && best.dist < 30 * 24 * 60 * 60 * 1000 ? best.close : null;
}

export async function GET(req: Request) {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const accountHashParam = searchParams.get('accountHash') ?? 'all';

  try {
    const tokens = await getTokens();
    if (!tokens) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    const client = await createClient();
    const allAccounts = await getAccountNumbers(tokens);
    const scoped = accountHashParam !== 'all'
      ? allAccounts.filter((a) => a.hashValue === accountHashParam)
      : allAccounts;
    if (!scoped.length) return NextResponse.json({ rows: [], pending: 0, generatedAt: Date.now() });

    // Full equity universe (seeds included).
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
    const universe = [...bySymbol.keys()];

    // Quotes in chunks of 50.
    const quotes: Record<string, { quote?: { lastPrice?: number; mark?: number; divYield?: number } }> = {};
    for (let i = 0; i < universe.length; i += QUOTE_CHUNK) {
      const chunk = universe.slice(i, i + QUOTE_CHUNK);
      try {
        Object.assign(quotes, await client.getQuotes(chunk));
      } catch (err) {
        console.warn('[TargetAlloc] quote chunk failed:', err);
      }
    }

    // History metric map: load, warm up to budget, persist.
    const store = getStore(HIST_STORE);
    let histMap: Record<string, HistMetric> = {};
    try {
      const raw = await store.get(HIST_KEY, { type: 'json' }) as Record<string, HistMetric> | null;
      if (raw && typeof raw === 'object') histMap = raw;
    } catch { /* start empty */ }

    const now = Date.now();
    const stale = universe.filter((sym) => {
      const m = histMap[sym];
      return !m || now - m.ts > HIST_TTL_MS;
    });
    const toFetch = stale.slice(0, HISTORY_BUDGET);

    if (toFetch.length > 0) {
      const to   = new Date().toISOString().split('T')[0];
      const from = new Date(now - 25 * 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const freshTokens = await getTokens();
      for (let i = 0; i < toFetch.length; i += CHUNK) {
        const wave = toFetch.slice(i, i + CHUNK);
        await Promise.all(wave.map(async (sym) => {
          try {
            const candles = (await getPriceHistory(freshTokens!, sym, from, to))
              .map((c) => ({ datetime: c.datetime, close: c.close }));
            const closes = candles.map((c) => c.close);
            histMap[sym] = {
              ts: now,
              sma50: closes.length >= 50 ? closes.slice(-50).reduce((s, v) => s + v, 0) / 50 : null,
              c12: closeNear(candles, 365),
              c24: closeNear(candles, 730),
            };
          } catch (err) {
            console.warn(`[TargetAlloc] history failed for ${sym}:`, err);
            // Record the attempt with nulls so one bad symbol can't consume
            // the budget forever; TTL will retry it tomorrow.
            histMap[sym] = { ts: now, sma50: null, c12: null, c24: null };
          }
        }));
      }
      try { await store.setJSON(HIST_KEY, histMap); } catch { /* non-fatal */ }
    }

    const pending = Math.max(0, stale.length - toFetch.length);

    const rows: AllocationRow[] = universe.map((sym) => {
      const pos   = bySymbol.get(sym)!;
      const q     = quotes[sym]?.quote;
      const price = q?.lastPrice ?? q?.mark ?? (pos.shares > 0 ? pos.marketValue / pos.shares : 0);
      const m     = histMap[sym];
      const hasHist = !!m && now - m.ts <= HIST_TTL_MS + 60_000;

      const liveYield = q?.divYield;
      const fb = getFallbackYieldPct(sym);
      const yieldPct = (typeof liveYield === 'number' && liveYield > 0) ? liveYield : (fb ?? 0);
      const meta = getFundMetadata(sym);

      const sma50 = hasHist ? m.sma50 : null;
      const c12   = hasHist ? m.c12 : null;
      const c24   = hasHist ? m.c24 : null;

      return {
        symbol:         sym,
        pillar:         meta?.pillar ?? 'other',
        family:         meta?.family ?? 'Other',
        shares:         pos.shares,
        price,
        marketValue:    pos.marketValue,
        isSeed:         pos.marketValue < SEED_MAX_DOLLARS,
        sma50:          sma50 !== null ? Math.round(sma50 * 100) / 100 : null,
        vsSma50Pct:     sma50 !== null && sma50 > 0 && price > 0 ? Math.round(((price / sma50) - 1) * 10_000) / 100 : null,
        ret12Pct:       c12 !== null && c12 > 0 ? Math.round(((price - c12) / c12) * 10_000) / 100 : null,
        ret24Pct:       c24 !== null && c24 > 0 ? Math.round(((price - c24) / c24) * 10_000) / 100 : null,
        yieldPct:       Math.round(yieldPct * 100) / 100,
        yieldSource:    (typeof liveYield === 'number' && liveYield > 0) ? 'live' : fb ? 'fallback' : 'none',
        maintenancePct: meta?.maintenancePct ?? 60,
        pending:        !hasHist,
      };
    });

    return NextResponse.json({ rows, pending, generatedAt: now });
  } catch (err) {
    console.error('[TargetAlloc API]', err);
    return NextResponse.json({ error: 'Failed to compute allocation metrics' }, { status: 500 });
  }
}

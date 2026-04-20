/**
 * Market Conditions API Endpoint
 *
 * Fetches VIX, S&P 500, and Nasdaq 100 from Yahoo Finance (public API, no key needed).
 * Schwab's quotes endpoint does not support index symbols ($VIX.X, $SPX.X, $NDX.X).
 */

import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

interface MarketData {
  vix: number;
  vixChange: number;
  sp500Price: number;
  sp500Change: number;
  nasdaq100Price: number;
  nasdaq100Change: number;
  marketTrend: 'bullish' | 'neutral' | 'bearish';
  volatilityLevel: 'low' | 'normal' | 'high' | 'extreme';
  lastUpdated: string;
}

interface AllocationRecommendation {
  recommendation: string;
  reason: string;
  suggestedChanges: {
    triplesPct?: number;
    cornerstonePct?: number;
    incomePct?: number;
    hedgePct?: number;
  };
  confidence: number;
  riskLevel: 'low' | 'medium' | 'high';
}

// Symbol maps: Yahoo Finance uses ^ prefix for indices, Polygon uses I: prefix
const YAHOO_SYMBOLS: Record<string, string> = { VIX: '^VIX', SPX: '^GSPC', NDX: '^NDX' };
const POLYGON_SYMBOLS: Record<string, string> = { VIX: 'I:VIX', SPX: 'I:SPX', NDX: 'I:NDX' };

async function polygonQuote(key: string): Promise<{ price: number; change: number; changePct: number }> {
  const apiKey = process.env.POLYGON_API_KEY;
  if (!apiKey) throw new Error('No POLYGON_API_KEY');
  const sym = POLYGON_SYMBOLS[key];
  const url = `https://api.polygon.io/v2/last/trade/${encodeURIComponent(sym)}?apiKey=${apiKey}`;
  const res = await fetch(url, { next: { revalidate: 0 } });
  if (!res.ok) throw new Error(`Polygon ${sym}: HTTP ${res.status}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json: any = await res.json();
  const price = json?.results?.p ?? 0;
  // Polygon last-trade doesn't include prev close — fetch prev close separately
  const snapUrl = `https://api.polygon.io/v2/snapshot/locale/us/markets/indices/tickers/${encodeURIComponent(sym)}?apiKey=${apiKey}`;
  const snapRes = await fetch(snapUrl, { next: { revalidate: 0 } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const snap: any = snapRes.ok ? await snapRes.json() : {};
  const prevClose = snap?.results?.prevDay?.c ?? price;
  const change    = price - prevClose;
  const changePct = prevClose > 0 ? (change / prevClose) * 100 : 0;
  return { price, change, changePct };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function yahooQuote(key: string): Promise<{ price: number; change: number; changePct: number }> {
  const symbol = YAHOO_SYMBOLS[key] ?? key;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, next: { revalidate: 0 } });
  if (!res.ok) throw new Error(`Yahoo Finance ${symbol}: HTTP ${res.status}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json: any = await res.json();
  const meta = json?.chart?.result?.[0]?.meta;
  if (!meta) throw new Error(`Yahoo Finance ${symbol}: no data`);
  const price     = meta.regularMarketPrice ?? meta.previousClose ?? 0;
  const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? price;
  const change    = price - prevClose;
  const changePct = prevClose > 0 ? (change / prevClose) * 100 : 0;
  return { price, change, changePct };
}

async function getQuote(key: string): Promise<{ price: number; change: number; changePct: number }> {
  if (process.env.POLYGON_API_KEY) {
    return polygonQuote(key).catch(() => yahooQuote(key));
  }
  return yahooQuote(key);
}

async function fetchMarketData(): Promise<{ data: MarketData; fetchError?: string }> {
  const now = new Date();

  try {
    const [vixRes, spxRes, ndxRes] = await Promise.all([
      getQuote('VIX'),
      getQuote('SPX'),
      getQuote('NDX'),
    ]);

    const vix = vixRes.price;

    let volatilityLevel: 'low' | 'normal' | 'high' | 'extreme';
    if (vix < 15) volatilityLevel = 'low';
    else if (vix < 25) volatilityLevel = 'normal';
    else if (vix < 40) volatilityLevel = 'high';
    else volatilityLevel = 'extreme';

    const marketTrend: 'bullish' | 'neutral' | 'bearish' =
      spxRes.changePct > 0.5 ? 'bullish' : spxRes.changePct < -0.5 ? 'bearish' : 'neutral';

    return {
      data: {
        vix,
        vixChange:       vixRes.change,
        sp500Price:      spxRes.price,
        sp500Change:     spxRes.changePct,
        nasdaq100Price:  ndxRes.price,
        nasdaq100Change: ndxRes.changePct,
        marketTrend,
        volatilityLevel,
        lastUpdated: now.toISOString(),
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[market-conditions] fetchMarketData error:', msg);
    return {
      data: {
        vix: 20, vixChange: 0,
        sp500Price: 0, sp500Change: 0,
        nasdaq100Price: 0, nasdaq100Change: 0,
        marketTrend: 'neutral',
        volatilityLevel: 'normal',
        lastUpdated: now.toISOString(),
      },
      fetchError: msg,
    };
  }
}

/** Normalize allocations so they always sum to exactly 100, adjusting income as the flex bucket. */
function normalize(t: number, c: number, i: number, h: number) {
  const adj = 100 - (t + c + i + h);
  return { triplesPct: t, cornerstonePct: c, incomePct: i + adj, hedgePct: h };
}

/**
 * Generate recommendation based on the COMBINED VIX + TREND LOGIC from Vol 7.
 * Allocations follow the system prompt's VIX-based and trend-based shift rules exactly.
 * All scenarios use Vol 7 base: Triples 10 / Cornerstone 20 / Income 65 / Hedge 5 = 100.
 * normalize() adjusts income as the flex bucket to guarantee the sum is always 100.
 */
function generateRecommendation(marketData: MarketData): AllocationRecommendation {
  const { vix, marketTrend } = marketData;
  const v = vix.toFixed(1);

  // VIX < 15 + BULLISH → MOST AGGRESSIVE: Triples +30% (VIX) +20% (trend) = 15%, Hedges min 2%
  if (vix < 15 && marketTrend === 'bullish') {
    return {
      recommendation: '🚀 Be Aggressive: Maximize Triples, Ride the Bull Market',
      reason: `VIX is low (${v}) and market is bullish — peak compounding environment. Raise Triples to 15%, cut Hedges to minimum 2%.`,
      suggestedChanges: normalize(15, 20, 63, 2),
      confidence: 0.85,
      riskLevel: 'medium',
    };
  }

  // VIX < 15 + NEUTRAL → Hold baseline (VIX calm but no trend signal)
  if (vix < 15 && marketTrend === 'neutral') {
    return {
      recommendation: '⏸️ Hold Baseline: Low Volatility, No Clear Trend',
      reason: `VIX is low (${v}) but market is flat. Hold Vol 7 baseline — no signal to deviate.`,
      suggestedChanges: normalize(10, 20, 65, 5),
      confidence: 0.70,
      riskLevel: 'low',
    };
  }

  // VIX < 15 + BEARISH → Contradictory signals; VIX calm but trend is down — hold baseline
  if (vix < 15 && marketTrend === 'bearish') {
    return {
      recommendation: '⚠️ Mixed Signals: Low VIX but Bearish Trend — Hold Baseline',
      reason: `VIX is low (${v}) yet market is trending down. Contradictory signals — hold baseline and monitor.`,
      suggestedChanges: normalize(10, 20, 65, 5),
      confidence: 0.55,
      riskLevel: 'low',
    };
  }

  // VIX 15–25 + BULLISH → MODERATE GROWTH: Triples +10% (11%), Income -5% (62%)
  if (vix >= 15 && vix < 25 && marketTrend === 'bullish') {
    return {
      recommendation: '✅ Moderate Growth: Lean Into Triples, Markets Are Healthy',
      reason: `VIX normal (${v}) with bullish trend. Triples +10% to 11%; rotate small income slice into growth.`,
      suggestedChanges: normalize(11, 20, 64, 5),
      confidence: 0.75,
      riskLevel: 'medium',
    };
  }

  // VIX 15–25 + NEUTRAL → Hold baseline
  if (vix >= 15 && vix < 25 && marketTrend === 'neutral') {
    return {
      recommendation: '⏸️ Hold Baseline: Normal Conditions, No Adjustment Needed',
      reason: `VIX normal (${v}) and market is flat. This is the range the strategy was designed for — no changes.`,
      suggestedChanges: normalize(10, 20, 65, 5),
      confidence: 0.70,
      riskLevel: 'low',
    };
  }

  // VIX 15–25 + BEARISH → DEFENSIVE: Triples -30% (7%), Hedges +50% (8%), Income +20% (65%)
  if (vix >= 15 && vix < 25 && marketTrend === 'bearish') {
    return {
      recommendation: '🛡️ Defensive: Reduce Triples, Raise Hedges, Protect Income',
      reason: `VIX normal (${v}) but market is trending down. Triples -30% to 7%; Hedges +50% to 8%; add bond stabilizers.`,
      suggestedChanges: normalize(7, 20, 65, 8),
      confidence: 0.75,
      riskLevel: 'medium',
    };
  }

  // VIX 25–40 + BULLISH → VIX level dominates; stay cautious despite bullish day
  if (vix >= 25 && vix < 40 && marketTrend === 'bullish') {
    return {
      recommendation: '⚠️ Stay Cautious: Elevated VIX Overrides Bullish Day',
      reason: `VIX elevated (${v}) despite a green day — do not chase. Hold reduced Triples; maintain hedges.`,
      suggestedChanges: normalize(8, 20, 64, 8),
      confidence: 0.75,
      riskLevel: 'medium',
    };
  }

  // VIX 25–40 + BEARISH or NEUTRAL → CAUTIOUS: Triples -40% (6%), Hedges +100% (10%)
  if (vix >= 25 && vix < 40) {
    return {
      recommendation: '⚠️ Be Cautious: Increase Hedges, Reduce Triples Exposure',
      reason: `VIX elevated (${v}) with uncertain/negative trend. Triples -40% to 6%; Hedges +100% to 10%. Sell Triples into strength, not weakness.`,
      suggestedChanges: normalize(6, 20, 64, 10),
      confidence: 0.80,
      riskLevel: 'medium',
    };
  }

  // VIX > 40 → EXTREME: Minimize Triples (2%), Maximize Hedges (15%), Cornerstone holds at 20%
  if (vix >= 40) {
    return {
      recommendation: '💎 Buy the Dip: Extreme Fear = Best Opportunity. Set Hedges, Buy on Weakness',
      reason: `VIX extreme (${v}) — panic mode. Raise hedges to 15%; nibble-buy Triples at 2%; DRIP at NAV is an automatic buying advantage.`,
      suggestedChanges: normalize(2, 20, 63, 15),
      confidence: 0.90,
      riskLevel: 'high',
    };
  }

  // Fallback (should not be reached)
  return {
    recommendation: '⏸️ Hold: No Clear Signal',
    reason: 'Market conditions are mixed. Hold current Vol 7 allocation.',
    suggestedChanges: normalize(10, 20, 65, 5),
    confidence: 0.60,
    riskLevel: 'low',
  };
}

export async function GET(request: NextRequest) {
  try {
    const { data: marketData, fetchError } = await fetchMarketData();
    const recommendation = generateRecommendation(marketData);

    return NextResponse.json(
      {
        success: true,
        marketData,
        recommendation,
        fetchError,
        timestamp: new Date().toISOString(),
      },
      {
        headers: {
          'Cache-Control': 'no-store, max-age=0', // Don't cache—always fresh
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (error) {
    console.error('Error fetching market conditions:', error);
    return NextResponse.json(
      { error: 'Failed to fetch market conditions' },
      { status: 500 }
    );
  }
}

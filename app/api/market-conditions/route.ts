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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function yahooQuote(symbol: string): Promise<{ price: number; change: number; changePct: number }> {
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

async function fetchMarketData(): Promise<{ data: MarketData; fetchError?: string }> {
  const now = new Date();

  try {
    const [vixRes, spxRes, ndxRes] = await Promise.all([
      yahooQuote('^VIX'),
      yahooQuote('^GSPC'),
      yahooQuote('^NDX'),
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
 * Generate AI recommendation based on market conditions.
 * All scenarios use Vol 7 base targets (Triples 10 / Cornerstone 20 / Income 65 / Hedge 5 = 100%)
 * and are guaranteed to sum to 100 via normalize().
 */
function generateRecommendation(marketData: MarketData): AllocationRecommendation {
  const { vix, marketTrend } = marketData;

  let reason = '';
  let confidence = 0.7;
  let riskLevel: 'low' | 'medium' | 'high' = 'medium';

  // Each set of four values must sum to 100. normalize() enforces this as a safety net.
  let alloc = normalize(10, 20, 65, 5); // Vol 7 defaults

  if (vix < 15 && marketTrend === 'bullish') {
    reason = `VIX is low (${vix.toFixed(1)}) and market is bullish. Markets are calm and rallying — ideal for leveraged exposure. Increase Triples to capture gains; trim hedges since downside risk is minimal.`;
    alloc = normalize(20, 20, 56, 4); // 100
    confidence = 0.85;
    riskLevel = 'medium';
  } else if (vix < 15 && marketTrend === 'neutral') {
    reason = `VIX is low (${vix.toFixed(1)}) but market is flat. Hold current Vol 7 allocation.`;
    alloc = normalize(10, 20, 65, 5); // 100
    confidence = 0.70;
    riskLevel = 'low';
  } else if (vix >= 15 && vix < 25 && marketTrend === 'bullish') {
    reason = `VIX is in normal range (${vix.toFixed(1)}) and market is bullish. Maintain balanced allocation with a slight lean toward growth.`;
    alloc = normalize(15, 20, 60, 5); // 100
    confidence = 0.75;
    riskLevel = 'medium';
  } else if (vix >= 25 && vix < 40 && (marketTrend === 'bearish' || marketTrend === 'neutral')) {
    reason = `VIX is elevated (${vix.toFixed(1)}) and market sentiment is uncertain. Increase hedges for downside protection; reduce Triples exposure.`;
    alloc = normalize(5, 20, 65, 10); // 100
    confidence = 0.80;
    riskLevel = 'medium';
  } else if (vix >= 40) {
    reason = `VIX is at extreme levels (${vix.toFixed(1)}) — market is in panic mode. Set maximum hedges now, then prepare dry powder to nibble-buy Triples on weakness.`;
    alloc = normalize(3, 17, 65, 15); // 100
    confidence = 0.90;
    riskLevel = 'high';
  } else {
    reason = `Market conditions are mixed. Hold current Vol 7 allocation with no major adjustments.`;
    alloc = normalize(10, 20, 65, 5); // 100
    confidence = 0.60;
    riskLevel = 'low';
  }

  return {
    recommendation: getRecommendationSummary(alloc.triplesPct, alloc.cornerstonePct, alloc.incomePct, alloc.hedgePct, vix, marketTrend),
    reason,
    suggestedChanges: alloc,
    confidence,
    riskLevel,
  };
}

function getRecommendationSummary(
  triples: number,
  cornerstone: number,
  income: number,
  hedge: number,
  vix: number,
  trend: string
): string {
  if (vix < 15 && trend === 'bullish') {
    return '🚀 Be Aggressive: Increase Triples, Ride the Bull Market';
  } else if (vix >= 25 && vix < 40) {
    return '⚠️ Be Cautious: Increase Hedges, Reduce Triples Exposure';
  } else if (vix >= 40) {
    return '💎 Buy the Dip: Extreme Fear = Best Opportunity. Set Hedges, Buy on Weakness';
  } else if (vix >= 15 && vix < 25 && trend === 'bullish') {
    return '✅ Stay Balanced: Markets are Healthy. Hold Your Current Allocation';
  } else {
    return '⏸️ Hold: Markets are Calm. No Major Adjustments Needed';
  }
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

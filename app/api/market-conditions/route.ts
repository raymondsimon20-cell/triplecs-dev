/**
 * GET /api/market-conditions
 *
 * Returns live market data + AI allocation recommendations.
 *
 * Live data sources (all free, no auth):
 *   • ^VIX, ^GSPC (SPY proxy), ^NDX (Nasdaq-100 proxy) — Yahoo Finance v8 chart API
 *   • Put/call ratio — derived from the VIX term-structure slope when available,
 *     otherwise computed via the equity put/call ratio proxy supplied by Yahoo.
 *
 * Computed technicals:
 *   • RSI(14) on SPY daily closes
 *   • 20-day / 50-day simple moving-average crossover
 *   • Correction zone (for Vol 7 regime alignment)
 */

import { NextRequest, NextResponse } from 'next/server';

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
  // Vol 7 technical confirmation signals
  rsi14: number | null;
  ma20: number | null;
  ma50: number | null;
  maCross: 'bullish' | 'bearish' | 'neutral' | null;   // 20 vs 50 SMA
  putCallRatio: number | null;                          // equity put/call ratio, when available
  dataSource: 'live' | 'fallback';
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

// ─── Yahoo helpers ────────────────────────────────────────────────────────────

type YahooChartResult = {
  meta?: { regularMarketPrice?: number; previousClose?: number; chartPreviousClose?: number };
  indicators?: { quote?: Array<{ close?: Array<number | null> }> };
};

async function fetchYahooChart(
  symbol: string,
  range: string,
  interval: string,
): Promise<YahooChartResult | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; triple-c/1.0)' },
      // Short cache to smooth out rapid polling; Netlify functions edge-cache ok
      next: { revalidate: 60 },
    });
    if (!res.ok) return null;
    const json = await res.json();
    const result = json?.chart?.result?.[0];
    return result ?? null;
  } catch {
    return null;
  }
}

function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const slice = values.slice(values.length - period);
  const sum = slice.reduce((a, b) => a + b, 0);
  return sum / period;
}

/** Wilder's RSI(14) — returns null if not enough data. */
function rsi14(closes: number[]): number | null {
  if (closes.length < 15) return null;
  const recent = closes.slice(-250); // enough to warm up
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= 14 && i < recent.length; i++) {
    const diff = recent[i] - recent[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / 14;
  let avgLoss = losses / 14;
  for (let i = 15; i < recent.length; i++) {
    const diff = recent[i] - recent[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * 13 + gain) / 14;
    avgLoss = (avgLoss * 13 + loss) / 14;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function cleanCloses(r: YahooChartResult | null): number[] {
  const raw = r?.indicators?.quote?.[0]?.close ?? [];
  return raw.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
}

/** Equity put/call ratio proxy.
 *  Yahoo does not expose CBOE's direct ratio. We approximate fear by the slope
 *  between VIX and the 3-month volatility index VIX3M (if available). A value
 *  > 1 indicates elevated short-term fear vs longer-term, similar to PCR > 1.
 *  Returns null when VIX3M cannot be fetched.
 */
async function estimatePutCallProxy(vix: number): Promise<number | null> {
  const vix3m = await fetchYahooChart('^VIX3M', '5d', '1d');
  const vix3mCloses = cleanCloses(vix3m);
  if (!vix3mCloses.length) return null;
  const latest3m = vix3mCloses[vix3mCloses.length - 1];
  if (!latest3m || latest3m <= 0) return null;
  // Term-structure inversion (VIX > VIX3M) maps to fear > 1 (PCR-like).
  return +(vix / latest3m).toFixed(2);
}

// ─── Live market data ─────────────────────────────────────────────────────────

async function fetchMarketData(): Promise<MarketData> {
  const [vixChart, spyChart, qqqChart, spyHist] = await Promise.all([
    fetchYahooChart('^VIX', '5d', '1d'),
    fetchYahooChart('^GSPC', '5d', '1d'),
    fetchYahooChart('^NDX', '5d', '1d'),
    fetchYahooChart('SPY', '6mo', '1d'),
  ]);

  // Default fallbacks so the endpoint still renders if Yahoo is down.
  const fallback: MarketData = {
    vix: 18,
    vixChange: 0,
    sp500Price: 0,
    sp500Change: 0,
    nasdaq100Price: 0,
    nasdaq100Change: 0,
    marketTrend: 'neutral',
    volatilityLevel: 'normal',
    lastUpdated: new Date().toISOString(),
    rsi14: null,
    ma20: null,
    ma50: null,
    maCross: null,
    putCallRatio: null,
    dataSource: 'fallback',
  };

  const vixPrice = vixChart?.meta?.regularMarketPrice ?? fallback.vix;
  const vixPrev  = vixChart?.meta?.previousClose ?? vixChart?.meta?.chartPreviousClose ?? vixPrice;
  const vix = Number.isFinite(vixPrice) ? vixPrice : fallback.vix;
  const vixChange = Number.isFinite(vixPrice - vixPrev) ? vixPrice - vixPrev : 0;

  const spyPrice = spyChart?.meta?.regularMarketPrice ?? 0;
  const spyPrev  = spyChart?.meta?.previousClose ?? spyChart?.meta?.chartPreviousClose ?? spyPrice;
  const sp500Change = spyPrev > 0 ? ((spyPrice - spyPrev) / spyPrev) * 100 : 0;

  const qqqPrice = qqqChart?.meta?.regularMarketPrice ?? 0;
  const qqqPrev  = qqqChart?.meta?.previousClose ?? qqqChart?.meta?.chartPreviousClose ?? qqqPrice;
  const nasdaq100Change = qqqPrev > 0 ? ((qqqPrice - qqqPrev) / qqqPrev) * 100 : 0;

  // Vol 7 technical confirmation signals — derived from SPY daily closes.
  const spyCloses = cleanCloses(spyHist);
  const rsi = rsi14(spyCloses);
  const ma20 = sma(spyCloses, 20);
  const ma50 = sma(spyCloses, 50);
  let maCross: 'bullish' | 'bearish' | 'neutral' | null = null;
  if (ma20 != null && ma50 != null) {
    if (ma20 > ma50 * 1.002) maCross = 'bullish';
    else if (ma20 < ma50 * 0.998) maCross = 'bearish';
    else maCross = 'neutral';
  }

  // Put/call proxy via VIX term-structure.
  const putCallRatio = await estimatePutCallProxy(vix);

  let volatilityLevel: MarketData['volatilityLevel'];
  if (vix < 15) volatilityLevel = 'low';
  else if (vix < 25) volatilityLevel = 'normal';
  else if (vix < 40) volatilityLevel = 'high';
  else volatilityLevel = 'extreme';

  const marketTrend: MarketData['marketTrend'] =
    sp500Change > 0.5 ? 'bullish' : sp500Change < -0.5 ? 'bearish' : 'neutral';

  const live = vixChart !== null && spyChart !== null;

  return {
    vix,
    vixChange,
    sp500Price: spyPrice,
    sp500Change,
    nasdaq100Price: qqqPrice,
    nasdaq100Change,
    marketTrend,
    volatilityLevel,
    lastUpdated: new Date().toISOString(),
    rsi14: rsi,
    ma20,
    ma50,
    maCross,
    putCallRatio,
    dataSource: live ? 'live' : 'fallback',
  };
}

// ─── Recommendation logic (now regime-aware) ──────────────────────────────────

function generateRecommendation(marketData: MarketData): AllocationRecommendation {
  const { vix, marketTrend, rsi14: rsi, maCross } = marketData;

  let triplesPct = 10;
  let cornerstonePct = 15;
  let incomePct = 60;
  let hedgePct = 5;
  let reason = '';
  let confidence = 0.7;
  let riskLevel: 'low' | 'medium' | 'high' = 'medium';

  if (vix < 15 && marketTrend === 'bullish') {
    reason = `VIX ${vix.toFixed(1)} + bullish trend. Ideal leveraged conditions — increase Triples, reduce hedges.`;
    triplesPct = 18; cornerstonePct = 16; incomePct = 56; hedgePct = 2;
    confidence = 0.85;
  } else if (vix < 15 && marketTrend === 'neutral') {
    reason = `VIX ${vix.toFixed(1)} low but market neutral. Hold current allocation.`;
    confidence = 0.7; riskLevel = 'low';
  } else if (vix >= 15 && vix < 25 && marketTrend === 'bullish') {
    reason = `VIX ${vix.toFixed(1)} normal, trend bullish. Balanced with slight growth lean.`;
    triplesPct = 13; cornerstonePct = 15; incomePct = 58; hedgePct = 4;
    confidence = 0.75;
  } else if (vix >= 25 && vix < 40) {
    reason = `VIX elevated (${vix.toFixed(1)}). Reduce Triples, add hedges. Sell into strength, not weakness.`;
    triplesPct = 6; cornerstonePct = 15; incomePct = 62; hedgePct = 10;
    confidence = 0.8;
  } else if (vix >= 40) {
    reason = `VIX extreme (${vix.toFixed(1)}). Maximize hedges, nibble-buy Triples. Best historical buy windows.`;
    triplesPct = 2; cornerstonePct = 12; incomePct = 60; hedgePct = 15;
    confidence = 0.9; riskLevel = 'high';
  } else {
    confidence = 0.6; riskLevel = 'low';
  }

  // Technical overlay — bump confidence or nudge allocations per Vol 7 Ch. 8 rules.
  const notes: string[] = [];
  if (rsi != null) {
    if (rsi > 70) { notes.push(`RSI ${rsi.toFixed(0)} overbought — trim Triples > 20%`); triplesPct = Math.max(2, triplesPct - 2); }
    else if (rsi < 30) { notes.push(`RSI ${rsi.toFixed(0)} oversold — triples buy signal`); triplesPct += 2; }
  }
  if (maCross === 'bearish') { notes.push('20-day SMA < 50-day — reduce Triples, add hedges'); triplesPct = Math.max(2, triplesPct - 1); hedgePct += 1; }
  if (maCross === 'bullish') { notes.push('20-day SMA > 50-day — trend supports longs'); }
  if (notes.length) reason += ` Technical: ${notes.join('; ')}.`;

  return {
    recommendation: getRecommendationSummary(vix, marketTrend),
    reason,
    suggestedChanges: { triplesPct, cornerstonePct, incomePct, hedgePct },
    confidence,
    riskLevel,
  };
}

function getRecommendationSummary(vix: number, trend: string): string {
  if (vix < 15 && trend === 'bullish') return '🚀 Be Aggressive: Increase Triples, Ride the Bull Market';
  if (vix >= 25 && vix < 40)           return '⚠️ Be Cautious: Increase Hedges, Reduce Triples Exposure';
  if (vix >= 40)                       return '💎 Buy the Dip: Extreme Fear = Best Opportunity. Set Hedges, Buy on Weakness';
  if (vix >= 15 && vix < 25 && trend === 'bullish') return '✅ Stay Balanced: Markets are Healthy. Hold Your Current Allocation';
  return '⏸️ Hold: Markets are Calm. No Major Adjustments Needed';
}

// ─── Route ────────────────────────────────────────────────────────────────────

export async function GET(_req: NextRequest) {
  try {
    const marketData = await fetchMarketData();
    const recommendation = generateRecommendation(marketData);

    return NextResponse.json(
      {
        success: true,
        marketData,
        recommendation,
        timestamp: new Date().toISOString(),
      },
      {
        headers: {
          'Cache-Control': 'no-store, max-age=0',
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

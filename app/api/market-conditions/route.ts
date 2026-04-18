/**
 * Market Conditions API Endpoint
 *
 * Fetches live VIX, S&P 500 (SPY), and Nasdaq 100 (QQQ) from Schwab quotes API.
 * Falls back to neutral defaults if the quote fetch fails (e.g. outside market hours).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTokens } from '@/lib/storage';
import { getQuotes } from '@/lib/schwab/client';

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

async function fetchMarketData(): Promise<MarketData> {
  const now = new Date();

  try {
    const tokens = await getTokens();
    if (!tokens) throw new Error('No Schwab tokens');

    // $VIX.X = CBOE VIX index; SPY = S&P 500 proxy; QQQ = Nasdaq 100 proxy
    const quotes = await getQuotes(tokens, ['$VIX.X', 'SPY', 'QQQ']);

    const vixQ   = quotes['$VIX.X']?.quote;
    const spyQ   = quotes['SPY']?.quote;
    const qqqQ   = quotes['QQQ']?.quote;

    const vix        = vixQ?.lastPrice  ?? 20;
    const vixChange  = vixQ?.netChange  ?? 0;
    const spyPrice   = spyQ?.lastPrice  ?? 0;
    const spyClose   = spyQ?.closePrice ?? spyPrice;
    const sp500Change = spyClose > 0 ? ((spyPrice - spyClose) / spyClose) * 100 : 0;
    const qqqPrice   = qqqQ?.lastPrice  ?? 0;
    const qqqClose   = qqqQ?.closePrice ?? qqqPrice;
    const nasdaqChange = qqqClose > 0 ? ((qqqPrice - qqqClose) / qqqClose) * 100 : 0;

    let volatilityLevel: 'low' | 'normal' | 'high' | 'extreme';
    if (vix < 15) volatilityLevel = 'low';
    else if (vix < 25) volatilityLevel = 'normal';
    else if (vix < 40) volatilityLevel = 'high';
    else volatilityLevel = 'extreme';

    const marketTrend: 'bullish' | 'neutral' | 'bearish' =
      sp500Change > 0.5 ? 'bullish' : sp500Change < -0.5 ? 'bearish' : 'neutral';

    return {
      vix,
      vixChange,
      sp500Price:      spyPrice,
      sp500Change,
      nasdaq100Price:  qqqPrice,
      nasdaq100Change: nasdaqChange,
      marketTrend,
      volatilityLevel,
      lastUpdated: now.toISOString(),
    };
  } catch {
    // Outside market hours or auth issue — return neutral defaults
    return {
      vix: 20, vixChange: 0,
      sp500Price: 0, sp500Change: 0,
      nasdaq100Price: 0, nasdaq100Change: 0,
      marketTrend: 'neutral',
      volatilityLevel: 'normal',
      lastUpdated: now.toISOString(),
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

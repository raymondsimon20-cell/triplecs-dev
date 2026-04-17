/**
 * Market Conditions API Endpoint
 *
 * Provides:
 *   • Real-time VIX data
 *   • Market trend analysis
 *   • AI-generated allocation recommendations based on volatility, trend, and VIX levels
 *
 * In production, this would integrate with:
 *   - MarketWatch or Yahoo Finance API for VIX quotes
 *   - IEX Cloud or Polygon.io for index quotes
 *   - Claude API for allocation recommendations
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

/**
 * Generate realistic market data (in production, fetch from real APIs)
 * This demonstrates how recommendations would be generated based on market conditions
 */
function generateMarketData(): MarketData {
  // Simulated market data (in production, fetch from MarketWatch, Yahoo Finance, etc.)
  const now = new Date();
  const hour = now.getHours();
  const isMarketOpen = hour >= 9 && hour < 16; // 9 AM - 4 PM ET

  // Realistic ranges during market hours
  const baseVix = isMarketOpen ? 15 + Math.random() * 20 : 16;
  const vixChange = (Math.random() - 0.5) * 5;

  const baseSP500 = 5450;
  const sp500Change = (Math.random() - 0.5) * 2;

  const baseNasdaq = 17850;
  const nasdaq100Change = (Math.random() - 0.5) * 1.5;

  const vix = Math.max(10, baseVix + vixChange);

  let volatilityLevel: 'low' | 'normal' | 'high' | 'extreme';
  if (vix < 15) volatilityLevel = 'low';
  else if (vix < 25) volatilityLevel = 'normal';
  else if (vix < 40) volatilityLevel = 'high';
  else volatilityLevel = 'extreme';

  const marketTrend: 'bullish' | 'neutral' | 'bearish' =
    sp500Change > 0.5 ? 'bullish' : sp500Change < -0.5 ? 'bearish' : 'neutral';

  return {
    vix: vix,
    vixChange: vixChange,
    sp500Price: baseSP500 + (sp500Change * 50),
    sp500Change: sp500Change,
    nasdaq100Price: baseNasdaq + (nasdaq100Change * 100),
    nasdaq100Change: nasdaq100Change,
    marketTrend,
    volatilityLevel,
    lastUpdated: now.toISOString(),
  };
}

/**
 * Normalize four pillar percentages so they sum to exactly 100.
 * Distributes rounding error to the largest bucket so each field stays an integer.
 */
function normalizeTargets(
  triples: number,
  cornerstone: number,
  income: number,
  hedge: number
): { triplesPct: number; cornerstonePct: number; incomePct: number; hedgePct: number } {
  const raw = { triples, cornerstone, income, hedge };
  const sum = raw.triples + raw.cornerstone + raw.income + raw.hedge;

  if (sum === 0) {
    return { triplesPct: 10, cornerstonePct: 20, incomePct: 65, hedgePct: 5 };
  }

  const scaled = {
    triples:     Math.round((raw.triples     / sum) * 100),
    cornerstone: Math.round((raw.cornerstone / sum) * 100),
    income:      Math.round((raw.income      / sum) * 100),
    hedge:       Math.round((raw.hedge       / sum) * 100),
  };

  // Absorb rounding drift into the largest bucket (usually Income).
  const drift = 100 - (scaled.triples + scaled.cornerstone + scaled.income + scaled.hedge);
  const largest = Object.entries(scaled).sort((a, b) => b[1] - a[1])[0][0] as keyof typeof scaled;
  scaled[largest] += drift;

  return {
    triplesPct:     scaled.triples,
    cornerstonePct: scaled.cornerstone,
    incomePct:      scaled.income,
    hedgePct:       scaled.hedge,
  };
}

/**
 * Generate AI recommendation based on market conditions.
 * All returned pillar targets sum to exactly 100%.
 */
function generateRecommendation(marketData: MarketData): AllocationRecommendation {
  const { vix, marketTrend } = marketData;

  // Base allocation targets (sum = 100)
  let triplesPct = 10;
  let cornerstonePct = 20;
  let incomePct = 65;
  let hedgePct = 5;
  let reason = '';
  let confidence = 0.7;
  let riskLevel: 'low' | 'medium' | 'high' = 'medium';

  // Recommendation logic based on VIX and market trend.
  // Each branch below must produce values that sum to 100.

  if (vix < 15 && marketTrend === 'bullish') {
    // Low volatility, bullish market → AGGRESSIVE: increase triples, reduce hedges
    reason = `VIX is low (${vix.toFixed(1)}) and market is bullish. Markets are calm and rallying —
             this is ideal for leveraged exposure. Increase Triples allocation to capture gains,
             reduce hedges since downside risk is minimal.`;
    triplesPct     = 20;
    cornerstonePct = 18;
    incomePct      = 60;
    hedgePct       = 2;
    confidence = 0.85;
    riskLevel = 'medium';
  } else if (vix < 15 && marketTrend === 'neutral') {
    // Low vol, flat market → HOLD
    reason = `VIX is low (${vix.toFixed(1)}) but market is neutral. Good time to hold current allocation.`;
    confidence = 0.7;
    riskLevel = 'low';
  } else if (vix >= 15 && vix < 25 && marketTrend === 'bullish') {
    // Normal vol, bullish → BALANCED, slight growth lean
    reason = `VIX is in normal range (${vix.toFixed(1)}) and market is bullish. Maintain balanced allocation
             with slight lean toward growth. Market conditions are healthy.`;
    triplesPct     = 14;
    cornerstonePct = 18;
    incomePct      = 64;
    hedgePct       = 4;
    confidence = 0.75;
    riskLevel = 'medium';
  } else if (vix >= 25 && vix < 40 && (marketTrend === 'bearish' || marketTrend === 'neutral')) {
    // Elevated vol, bearish/neutral → CAUTIOUS: increase hedges, reduce triples
    reason = `VIX is elevated (${vix.toFixed(1)}) and market sentiment is uncertain.
             Increase hedges for protection against downside. Reduce aggressive Triples exposure.`;
    triplesPct     = 5;
    cornerstonePct = 18;
    incomePct      = 67;
    hedgePct       = 10;
    confidence = 0.8;
    riskLevel = 'medium';
  } else if (vix >= 40) {
    // Extreme fear → DEFENSIVE: maximize hedges, minimize triples
    reason = `VIX is at extreme levels (${vix.toFixed(1)})—market is in panic mode.
             This is typically the best time to BUY after setting up hedges. Reduce Triples,
             add put hedges, and prepare dry powder to buy dips.`;
    triplesPct     = 3;
    cornerstonePct = 15;
    incomePct      = 67;
    hedgePct       = 15;
    confidence = 0.9;
    riskLevel = 'high';
  } else {
    // Default: hold current targets
    confidence = 0.6;
    riskLevel = 'low';
  }

  // Safety net: guarantee the four values always sum to exactly 100.
  const normalized = normalizeTargets(triplesPct, cornerstonePct, incomePct, hedgePct);

  return {
    recommendation: getRecommendationSummary(
      normalized.triplesPct, normalized.cornerstonePct, normalized.incomePct, normalized.hedgePct,
      vix, marketTrend
    ),
    reason,
    suggestedChanges: normalized,
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
    // In production:
    // 1. Fetch real VIX from MarketWatch API or Yahoo Finance
    // 2. Fetch S&P 500 and Nasdaq 100 quotes from IEX Cloud or Polygon.io
    // 3. Call Claude API to generate personalized recommendations

    const marketData = generateMarketData();
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

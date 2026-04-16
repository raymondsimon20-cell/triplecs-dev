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
 * Generate AI recommendation based on market conditions
 */
function generateRecommendation(marketData: MarketData): AllocationRecommendation {
  const { vix, volatilityLevel, marketTrend } = marketData;

  // Base allocation targets
  let triplesPct = 10;
  let cornerstonePct = 15;
  let incomePct = 60;
  let hedgePct = 5;
  let reason = '';
  let confidence = 0.7;
  let riskLevel: 'low' | 'medium' | 'high' = 'medium';

  // Recommendation logic based on VIX and market trend

  if (vix < 15 && marketTrend === 'bullish') {
    // Low volatility, bullish market → AGGRESSIVE: increase triples, reduce hedges
    reason = `VIX is low (${vix.toFixed(1)}) and market is bullish. Markets are calm and rallying —
             this is ideal for leveraged exposure. Increase Triples allocation to capture gains,
             reduce hedges since downside risk is minimal.`;
    triplesPct = 18;  // Up from 10
    cornerstonePct = 16;
    incomePct = 56;
    hedgePct = 2;  // Down from 5
    confidence = 0.85;
    riskLevel = 'medium';
  } else if (vix < 15 && marketTrend === 'neutral') {
    // Low vol, flat market → HOLD or slight increase
    reason = `VIX is low (${vix.toFixed(1)}) but market is neutral. Good time to hold current allocation.`;
    confidence = 0.7;
    riskLevel = 'low';
  } else if (vix >= 15 && vix < 25 && marketTrend === 'bullish') {
    // Normal vol, bullish → BALANCED but slightly bullish
    reason = `VIX is in normal range (${vix.toFixed(1)}) and market is bullish. Maintain balanced allocation
             with slight lean toward growth. Market conditions are healthy.`;
    triplesPct = 13;
    cornerstonePct = 15;
    incomePct = 58;
    hedgePct = 4;
    confidence = 0.75;
    riskLevel = 'medium';
  } else if (vix >= 25 && vix < 40 && (marketTrend === 'bearish' || marketTrend === 'neutral')) {
    // Elevated vol, bearish/neutral → CAUTIOUS: increase hedges, reduce triples
    reason = `VIX is elevated (${vix.toFixed(1)}) and market sentiment is uncertain.
             Increase hedges for protection against downside. Reduce aggressive Triples exposure.`;
    triplesPct = 6;   // Down from 10
    cornerstonePct = 15;
    incomePct = 62;
    hedgePct = 10;   // Up from 5
    confidence = 0.8;
    riskLevel = 'medium';
  } else if (vix >= 40) {
    // Extreme fear → DEFENSIVE: maximize hedges, minimize triples
    reason = `VIX is at extreme levels (${vix.toFixed(1)})—market is in panic mode.
             This is typically the best time to BUY after setting up hedges. Reduce Triples,
             add put hedges, and prepare dry powder to buy dips.`;
    triplesPct = 2;   // Minimal
    cornerstonePct = 12;
    incomePct = 60;
    hedgePct = 15;   // Maximum hedge protection
    confidence = 0.9;
    riskLevel = 'high';
  } else {
    // Default: hold current targets
    confidence = 0.6;
    riskLevel = 'low';
  }

  return {
    recommendation: getRecommendationSummary(triplesPct, cornerstonePct, incomePct, hedgePct, vix, marketTrend),
    reason,
    suggestedChanges: {
      triplesPct,
      cornerstonePct,
      incomePct,
      hedgePct,
    },
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

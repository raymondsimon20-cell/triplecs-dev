'use client';

/**
 * MarketConditionsDashboard — Real-time market metrics and AI allocation recommendations.
 *
 * Shows:
 *   • Live VIX level with interpretation
 *   • Market volatility status
 *   • 5-day, 20-day, and 52-week trend indicators
 *   • AI recommendations for allocation adjustments based on current conditions
 *   • Confidence levels and reasoning
 */

import { useEffect, useState } from 'react';
import { TrendingUp, TrendingDown, Zap, AlertCircle, CheckCircle, Brain } from 'lucide-react';
import { type StrategyTargets } from '@/lib/utils';

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
  stale?: boolean;
  error?: string;
}

interface AllocationRecommendation {
  recommendation: string;
  reason: string;
  suggestedChanges: Partial<StrategyTargets>;
  confidence: number;
  riskLevel: 'low' | 'medium' | 'high';
}

interface MarketConditionsDashboardProps {
  currentTargets: StrategyTargets;
  onTargetsChange?: (newTargets: StrategyTargets) => void;
}

export function MarketConditionsDashboard({
  currentTargets,
  onTargetsChange,
}: MarketConditionsDashboardProps) {
  const [marketData, setMarketData] = useState<MarketData | null>(null);
  const [recommendation, setRecommendation] = useState<AllocationRecommendation | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastFetchTime, setLastFetchTime] = useState<string>('');
  const [showApplyButton, setShowApplyButton] = useState(false);

  useEffect(() => {
    const fetchMarketData = async () => {
      try {
        setLoading(true);
        const response = await fetch('/api/market-conditions');
        if (response.ok) {
          const data = await response.json();
          setMarketData(data.marketData);
          setRecommendation(data.recommendation);
        } else {
          setMarketData({
            vix: 20, vixChange: 0,
            sp500Price: 0, sp500Change: 0,
            nasdaq100Price: 0, nasdaq100Change: 0,
            marketTrend: 'neutral',
            volatilityLevel: 'normal',
            lastUpdated: new Date().toISOString(),
            stale: true,
            error: `API error ${response.status}`,
          });
        }
      } catch (error) {
        console.error('Failed to fetch market data:', error);
        setMarketData({
          vix: 20, vixChange: 0,
          sp500Price: 0, sp500Change: 0,
          nasdaq100Price: 0, nasdaq100Change: 0,
          marketTrend: 'neutral',
          volatilityLevel: 'normal',
          lastUpdated: new Date().toISOString(),
          stale: true,
          error: 'Network error — unable to reach /api/market-conditions',
        });
      } finally {
        setLoading(false);
        setLastFetchTime(new Date().toLocaleTimeString());
      }
    };

    fetchMarketData();
    const interval = setInterval(fetchMarketData, 60000); // Refresh every 60 seconds during market hours

    return () => clearInterval(interval);
  }, []);

  if (!marketData) return null;

  const applyRecommendation = () => {
    if (!recommendation || !onTargetsChange) return;

    const newTargets: StrategyTargets = {
      ...currentTargets,
      triplesPct: recommendation.suggestedChanges.triplesPct ?? currentTargets.triplesPct,
      cornerstonePct: recommendation.suggestedChanges.cornerstonePct ?? currentTargets.cornerstonePct,
      incomePct: recommendation.suggestedChanges.incomePct ?? currentTargets.incomePct,
      hedgePct: recommendation.suggestedChanges.hedgePct ?? currentTargets.hedgePct,
    };
    onTargetsChange(newTargets);
    setShowApplyButton(false);
  };

  const getVIXColor = (vix: number) => {
    if (vix < 15) return 'text-green-400';
    if (vix < 25) return 'text-yellow-400';
    if (vix < 40) return 'text-orange-400';
    return 'text-red-400';
  };

  const getVIXLabel = (vix: number): string => {
    if (vix < 15) return 'Low (Bull Territory)';
    if (vix < 25) return 'Normal (Stable)';
    if (vix < 40) return 'High (Caution)';
    return 'Extreme (Stress)';
  };

  const getVolatilityBg = (level: string) => {
    switch (level) {
      case 'low':
        return 'bg-green-900/20 border-green-800/50';
      case 'normal':
        return 'bg-blue-900/20 border-blue-800/50';
      case 'high':
        return 'bg-orange-900/20 border-orange-800/50';
      case 'extreme':
        return 'bg-red-900/20 border-red-800/50';
      default:
        return 'bg-gray-900/20 border-gray-800/50';
    }
  };

  const getTrendIcon = (change: number) => {
    if (change > 0) return <TrendingUp className="w-4 h-4 text-green-400" />;
    if (change < 0) return <TrendingDown className="w-4 h-4 text-red-400" />;
    return <Zap className="w-4 h-4 text-yellow-400" />;
  };

  const getTrendColor = (change: number) => {
    if (change > 0) return 'text-green-400';
    if (change < 0) return 'text-red-400';
    return 'text-yellow-400';
  };

  return (
    <div className="w-full space-y-4">
      {marketData.stale && (
        <div className="bg-red-900/20 border border-red-800/50 rounded-lg p-3 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
          <div className="text-xs">
            <p className="text-red-300 font-semibold">Live market data unavailable</p>
            <p className="text-gray-400 mt-0.5">
              {marketData.error ?? 'Showing neutral defaults. Check Schwab connection on the Settings tab.'}
            </p>
          </div>
        </div>
      )}
      {!marketData.stale && marketData.error && (
        <div className="bg-yellow-900/20 border border-yellow-800/50 rounded-lg p-2 flex items-center gap-2 text-xs text-yellow-300">
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
          {marketData.error}
        </div>
      )}
      {/* Market Overview Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {/* VIX Card */}
        <div className={`bg-gradient-to-br ${getVolatilityBg(marketData.volatilityLevel)} border rounded-lg p-4`}>
          <div className="flex items-start justify-between mb-3">
            <div>
              <p className="text-xs text-gray-400 font-medium">VIX Index</p>
              <p className={`text-3xl font-bold ${getVIXColor(marketData.vix)}`}>
                {marketData.vix.toFixed(1)}
              </p>
            </div>
            <div className={`p-2 rounded-lg ${getVolatilityBg(marketData.volatilityLevel).replace('border', 'bg')}`}>
              <AlertCircle className={`w-5 h-5 ${getVIXColor(marketData.vix)}`} />
            </div>
          </div>
          <p className={`text-xs font-semibold ${getVIXColor(marketData.vix)}`}>
            {getVIXLabel(marketData.vix)}
          </p>
          <p className={`text-xs mt-1 ${getTrendColor(marketData.vixChange)}`}>
            {marketData.vixChange > 0 ? '↑' : '↓'} {Math.abs(marketData.vixChange).toFixed(2)} today
          </p>
        </div>

        {/* S&P 500 Card */}
        <div className="bg-gradient-to-br from-blue-900/20 to-blue-800/20 border border-blue-800/50 rounded-lg p-4">
          <div className="flex items-start justify-between mb-3">
            <div>
              <p className="text-xs text-gray-400 font-medium">S&P 500</p>
              <p className="text-2xl font-bold text-white">
                {marketData.sp500Price.toLocaleString('en-US', { maximumFractionDigits: 1 })}
              </p>
            </div>
            <div className="p-2 rounded-lg bg-blue-900/30">
              {getTrendIcon(marketData.sp500Change)}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className={`text-xs font-semibold ${getTrendColor(marketData.sp500Change)}`}>
              {marketData.sp500Change > 0 ? '+' : ''}{marketData.sp500Change.toFixed(2)}%
            </span>
            <span className="text-xs text-gray-500">today</span>
          </div>
        </div>

        {/* Nasdaq 100 Card */}
        <div className="bg-gradient-to-br from-cyan-900/20 to-cyan-800/20 border border-cyan-800/50 rounded-lg p-4">
          <div className="flex items-start justify-between mb-3">
            <div>
              <p className="text-xs text-gray-400 font-medium">Nasdaq 100</p>
              <p className="text-2xl font-bold text-white">
                {marketData.nasdaq100Price.toLocaleString('en-US', { maximumFractionDigits: 1 })}
              </p>
            </div>
            <div className="p-2 rounded-lg bg-cyan-900/30">
              {getTrendIcon(marketData.nasdaq100Change)}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className={`text-xs font-semibold ${getTrendColor(marketData.nasdaq100Change)}`}>
              {marketData.nasdaq100Change > 0 ? '+' : ''}{marketData.nasdaq100Change.toFixed(2)}%
            </span>
            <span className="text-xs text-gray-500">today</span>
          </div>
        </div>
      </div>

      {/* AI Recommendation Card */}
      {recommendation && (
        <div className="bg-gradient-to-br from-purple-900/20 to-purple-800/20 border border-purple-800/50 rounded-lg p-4">
          <div className="flex items-start gap-3 mb-3">
            <div className="p-2 rounded-lg bg-purple-900/30">
              <Brain className="w-5 h-5 text-purple-400" />
            </div>
            <div className="flex-1">
              <p className="text-sm font-bold text-white">AI Allocation Recommendation</p>
              <p className="text-xs text-gray-400 mt-0.5">
                Based on current market conditions and your portfolio
              </p>
            </div>
            <div className={`px-2 py-1 rounded text-xs font-semibold ${
              recommendation.confidence > 0.8
                ? 'bg-green-900/40 text-green-300'
                : recommendation.confidence > 0.6
                ? 'bg-yellow-900/40 text-yellow-300'
                : 'bg-orange-900/40 text-orange-300'
            }`}>
              {(recommendation.confidence * 100).toFixed(0)}% Confidence
            </div>
          </div>

          <div className="bg-[#1e2139] rounded p-3 mb-3">
            <p className="text-sm text-white font-medium mb-2">{recommendation.recommendation}</p>
            <p className="text-xs text-gray-300">{recommendation.reason}</p>
          </div>

          {/* Suggested Changes */}
          {recommendation.suggestedChanges && (
            <div className="space-y-2 mb-3">
              <p className="text-xs font-semibold text-gray-400">Suggested Adjustments:</p>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                {recommendation.suggestedChanges.triplesPct !== undefined && (
                  <div className="bg-[#1e2139] rounded p-2 border border-emerald-800/30">
                    <p className="text-xs text-gray-400">Triples Target</p>
                    <p className="text-sm font-bold text-emerald-400">
                      {recommendation.suggestedChanges.triplesPct}%
                    </p>
                    {recommendation.suggestedChanges.triplesPct !== currentTargets.triplesPct && (
                      <p className={`text-xs mt-1 ${
                        recommendation.suggestedChanges.triplesPct > currentTargets.triplesPct
                          ? 'text-green-400'
                          : 'text-red-400'
                      }`}>
                        {recommendation.suggestedChanges.triplesPct > currentTargets.triplesPct ? '↑' : '↓'} from {currentTargets.triplesPct}%
                      </p>
                    )}
                  </div>
                )}
                {recommendation.suggestedChanges.cornerstonePct !== undefined && (
                  <div className="bg-[#1e2139] rounded p-2 border border-amber-800/30">
                    <p className="text-xs text-gray-400">Cornerstone Target</p>
                    <p className="text-sm font-bold text-amber-400">
                      {recommendation.suggestedChanges.cornerstonePct}%
                    </p>
                    {recommendation.suggestedChanges.cornerstonePct !== currentTargets.cornerstonePct && (
                      <p className={`text-xs mt-1 ${
                        recommendation.suggestedChanges.cornerstonePct > currentTargets.cornerstonePct
                          ? 'text-green-400'
                          : 'text-red-400'
                      }`}>
                        {recommendation.suggestedChanges.cornerstonePct > currentTargets.cornerstonePct ? '↑' : '↓'} from {currentTargets.cornerstonePct}%
                      </p>
                    )}
                  </div>
                )}
                {recommendation.suggestedChanges.incomePct !== undefined && (
                  <div className="bg-[#1e2139] rounded p-2 border border-purple-800/30">
                    <p className="text-xs text-gray-400">Income Target</p>
                    <p className="text-sm font-bold text-purple-400">
                      {recommendation.suggestedChanges.incomePct}%
                    </p>
                    {recommendation.suggestedChanges.incomePct !== currentTargets.incomePct && (
                      <p className={`text-xs mt-1 ${
                        recommendation.suggestedChanges.incomePct > currentTargets.incomePct
                          ? 'text-green-400'
                          : 'text-red-400'
                      }`}>
                        {recommendation.suggestedChanges.incomePct > currentTargets.incomePct ? '↑' : '↓'} from {currentTargets.incomePct}%
                      </p>
                    )}
                  </div>
                )}
                {recommendation.suggestedChanges.hedgePct !== undefined && (
                  <div className="bg-[#1e2139] rounded p-2 border border-red-800/30">
                    <p className="text-xs text-gray-400">Hedge Target</p>
                    <p className="text-sm font-bold text-red-400">
                      {recommendation.suggestedChanges.hedgePct}%
                    </p>
                    {recommendation.suggestedChanges.hedgePct !== currentTargets.hedgePct && (
                      <p className={`text-xs mt-1 ${
                        recommendation.suggestedChanges.hedgePct > currentTargets.hedgePct
                          ? 'text-green-400'
                          : 'text-red-400'
                      }`}>
                        {recommendation.suggestedChanges.hedgePct > currentTargets.hedgePct ? '↑' : '↓'} from {currentTargets.hedgePct}%
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Risk Level Indicator */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs">
              <span className="text-gray-400">Risk Level:</span>
              <span className={`px-2 py-1 rounded font-semibold ${
                recommendation.riskLevel === 'low'
                  ? 'bg-green-900/40 text-green-300'
                  : recommendation.riskLevel === 'medium'
                  ? 'bg-yellow-900/40 text-yellow-300'
                  : 'bg-red-900/40 text-red-300'
              }`}>
                {recommendation.riskLevel.toUpperCase()}
              </span>
            </div>
            {onTargetsChange && (
              <button
                onClick={applyRecommendation}
                className="text-xs px-3 py-1 rounded bg-purple-600 hover:bg-purple-700 text-white font-semibold transition-colors"
              >
                Apply to Settings
              </button>
            )}
          </div>
        </div>
      )}

      {/* Update Info */}
      <div className="text-xs text-gray-500 text-right">
        Last updated: {lastFetchTime}
        {loading && ' (updating...)'}
      </div>
    </div>
  );
}

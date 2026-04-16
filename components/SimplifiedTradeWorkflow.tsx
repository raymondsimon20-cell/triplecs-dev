'use client';

/**
 * SimplifiedTradeWorkflow — Easy-to-understand trade guidance
 *
 * Shows:
 *   • Current allocation vs. targets (visual comparison)
 *   • Which pillars are over/under allocated
 *   • Exact buy/sell amounts needed to rebalance
 *   • Step-by-step workflow to execute trades
 *   • Pre-filled order suggestions for Schwab
 */

import { useState } from 'react';
import { ArrowRight, AlertCircle, CheckCircle, ArrowUp, ArrowDown, Copy, ExternalLink } from 'lucide-react';
import type { EnrichedPosition, PillarType } from '@/lib/schwab/types';
import type { PillarSummary } from '@/lib/classify';
import type { StrategyTargets } from '@/lib/utils';
import { fmt$ } from '@/lib/utils';

interface TradeAction {
  pillar: string;
  action: 'BUY' | 'SELL';
  amount: number;
  percentChange: number;
  reason: string;
  suggestedSymbols: string[];
}

export function SimplifiedTradeWorkflow({
  pillars,
  positions,
  totalValue,
  currentTargets,
  marginData,
}: {
  pillars: PillarSummary[];
  positions: EnrichedPosition[];
  totalValue: number;
  currentTargets: StrategyTargets;
  marginData?: { equity: number; marginBalance: number };
}) {
  const [step, setStep] = useState<'review' | 'details' | 'execute'>(
    'review'
  );
  const [selectedTrade, setSelectedTrade] = useState<TradeAction | null>(null);

  // Calculate trade actions needed
  const pillarMap = new Map(pillars.map((p) => [p.pillar, p]));
  const trades: TradeAction[] = [];

  const targets = {
    triples: currentTargets.triplesPct,
    cornerstone: currentTargets.cornerstonePct,
    income: currentTargets.incomePct,
    hedge: currentTargets.hedgePct,
  };

  // Generate trade recommendations
  for (const [pillar, target] of Object.entries(targets)) {
    const pillarData = pillarMap.get(pillar as PillarType);
    const current = pillarData?.portfolioPercent || 0;
    const diff = current - target;

    if (Math.abs(diff) > 0.5) {
      // Only suggest trades if drift is > 0.5%
      const dollarAmount = (diff / 100) * totalValue;

      trades.push({
        pillar: pillarData?.label || pillar,
        action: diff > 0 ? 'SELL' : 'BUY',
        amount: Math.abs(dollarAmount),
        percentChange: Math.abs(diff),
        reason:
          diff > 0
            ? `Currently at ${current.toFixed(1)}% (${diff.toFixed(1)}% over target)`
            : `Currently at ${current.toFixed(1)}% (${Math.abs(diff).toFixed(1)}% under target)`,
        suggestedSymbols: getSuggestedSymbols(
          pillar as PillarType,
          diff > 0 ? 'SELL' : 'BUY',
          positions
        ),
      });
    }
  }

  // Sort: SELLS first, then BUYS
  trades.sort((a, b) => {
    if (a.action === 'SELL' && b.action === 'BUY') return -1;
    if (a.action === 'BUY' && b.action === 'SELL') return 1;
    return 0;
  });

  return (
    <div className="w-full bg-gradient-to-b from-[#0f1117] to-[#1a1f36] rounded-lg border border-blue-900/30 overflow-hidden">
      {/* Header */}
      <div className="bg-gradient-to-r from-blue-900/40 to-purple-900/40 border-b border-blue-800/50 px-4 py-3">
        <h2 className="text-base font-bold text-white">Rebalance Workflow</h2>
        <p className="text-xs text-gray-400 mt-1">
          Step-by-step guidance to align your portfolio with target allocations
        </p>
      </div>

      {/* Content */}
      <div className="p-4 space-y-4">
        {trades.length === 0 ? (
          <div className="bg-green-900/20 border border-green-800/50 rounded-lg p-4 text-center">
            <CheckCircle className="w-8 h-8 text-green-400 mx-auto mb-2" />
            <p className="text-sm font-semibold text-green-300">Portfolio is Balanced</p>
            <p className="text-xs text-gray-400 mt-1">
              Your current allocation matches your targets. No trades needed.
            </p>
          </div>
        ) : (
          <>
            {/* Step 1: Review */}
            {step === 'review' && (
              <div className="space-y-3">
                <div className="bg-blue-900/20 border border-blue-800/50 rounded-lg p-3">
                  <p className="text-sm font-semibold text-blue-300 mb-2">
                    📋 Step 1: Review Trades
                  </p>
                  <p className="text-xs text-gray-300">
                    {trades.length} trade{trades.length > 1 ? 's' : ''} needed to rebalance your portfolio.
                  </p>
                </div>

                {/* Trade List */}
                <div className="space-y-2">
                  {trades.map((trade, idx) => (
                    <div
                      key={idx}
                      onClick={() => {
                        setSelectedTrade(trade);
                        setStep('details');
                      }}
                      className="bg-[#1e2139] border border-gray-800 rounded-lg p-3 cursor-pointer hover:border-blue-600/50 hover:bg-[#252d4a] transition-all"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 flex-1">
                          <div
                            className={`p-2 rounded-lg ${
                              trade.action === 'SELL'
                                ? 'bg-red-900/30 text-red-400'
                                : 'bg-green-900/30 text-green-400'
                            }`}
                          >
                            {trade.action === 'SELL' ? (
                              <ArrowUp className="w-4 h-4" />
                            ) : (
                              <ArrowDown className="w-4 h-4" />
                            )}
                          </div>
                          <div>
                            <p className="text-sm font-semibold text-white">
                              {trade.action} {trade.pillar}
                            </p>
                            <p className="text-xs text-gray-400">
                              {trade.reason}
                            </p>
                          </div>
                        </div>
                        <div className="text-right">
                          <p
                            className={`text-sm font-bold ${
                              trade.action === 'SELL'
                                ? 'text-red-400'
                                : 'text-green-400'
                            }`}
                          >
                            {trade.action === 'SELL' ? '-' : '+'}
                            {fmt$(trade.amount)}
                          </p>
                          <p className="text-xs text-gray-400">
                            {trade.percentChange.toFixed(1)}%
                          </p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                <button
                  onClick={() => setStep('details')}
                  className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2 rounded-lg transition-colors flex items-center justify-center gap-2"
                >
                  Next: Review Details <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            )}

            {/* Step 2: Details */}
            {step === 'details' && selectedTrade && (
              <div className="space-y-3">
                <button
                  onClick={() => setStep('review')}
                  className="text-sm text-blue-400 hover:text-blue-300 flex items-center gap-1"
                >
                  ← Back to Review
                </button>

                <div
                  className={`rounded-lg p-4 border ${
                    selectedTrade.action === 'SELL'
                      ? 'bg-red-900/20 border-red-800/50'
                      : 'bg-green-900/20 border-green-800/50'
                  }`}
                >
                  <div className="flex items-start gap-3 mb-3">
                    <div
                      className={`p-2 rounded-lg ${
                        selectedTrade.action === 'SELL'
                          ? 'bg-red-900/40 text-red-400'
                          : 'bg-green-900/40 text-green-400'
                      }`}
                    >
                      {selectedTrade.action === 'SELL' ? (
                        <ArrowUp className="w-5 h-5" />
                      ) : (
                        <ArrowDown className="w-5 h-5" />
                      )}
                    </div>
                    <div>
                      <p className="text-lg font-bold text-white">
                        {selectedTrade.action} {selectedTrade.pillar}
                      </p>
                      <p className="text-sm text-gray-300 mt-1">
                        {selectedTrade.reason}
                      </p>
                    </div>
                  </div>

                  <div className="bg-[#1e2139] rounded p-3 mb-3">
                    <p className="text-xs text-gray-400 mb-1">Amount to {selectedTrade.action.toLowerCase()}</p>
                    <p className="text-2xl font-bold text-white">
                      {fmt$(selectedTrade.amount)}
                    </p>
                  </div>

                  {selectedTrade.suggestedSymbols.length > 0 && (
                    <div className="bg-[#1e2139] rounded p-3">
                      <p className="text-xs font-semibold text-gray-400 mb-2">
                        💡 Suggested Symbols:
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {selectedTrade.suggestedSymbols.map((symbol) => (
                          <div
                            key={symbol}
                            className="bg-gray-800 hover:bg-gray-700 px-2 py-1 rounded text-xs text-white font-mono cursor-pointer transition-colors flex items-center gap-1"
                          >
                            {symbol}
                            <Copy className="w-3 h-3 text-gray-500" />
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                <button
                  onClick={() => setStep('execute')}
                  className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2 rounded-lg transition-colors flex items-center justify-center gap-2"
                >
                  Next: Execute Trades <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            )}

            {/* Step 3: Execute */}
            {step === 'execute' && (
              <div className="space-y-3">
                <button
                  onClick={() => setStep('details')}
                  className="text-sm text-blue-400 hover:text-blue-300 flex items-center gap-1"
                >
                  ← Back to Details
                </button>

                <div className="bg-amber-900/20 border border-amber-800/50 rounded-lg p-3">
                  <div className="flex gap-2 items-start">
                    <AlertCircle className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm font-semibold text-amber-300">
                        Ready to execute trades?
                      </p>
                      <p className="text-xs text-gray-300 mt-1">
                        Click the button below to go to Schwab and place orders for all
                        recommended trades.
                      </p>
                    </div>
                  </div>
                </div>

                {/* Trade Summary */}
                <div className="bg-[#1e2139] rounded-lg p-3 space-y-2 border border-gray-800">
                  <p className="text-xs font-semibold text-gray-400">Summary:</p>
                  {trades.map((trade, idx) => (
                    <div
                      key={idx}
                      className="flex items-center justify-between text-xs"
                    >
                      <span className="text-gray-300">
                        {trade.action} {trade.amount > 0 ? fmt$(trade.amount) : 'N/A'} of{' '}
                        {trade.pillar}
                      </span>
                      <span
                        className={
                          trade.action === 'SELL'
                            ? 'text-red-400'
                            : 'text-green-400'
                        }
                      >
                        {trade.action === 'SELL' ? '-' : '+'}
                        {trade.percentChange.toFixed(1)}%
                      </span>
                    </div>
                  ))}
                </div>

                <button
                  onClick={() => {
                    // In production: open Schwab in new tab with pre-filled order form
                    window.open('https://client.schwab.com', '_blank');
                  }}
                  className="w-full bg-green-600 hover:bg-green-700 text-white font-semibold py-2 rounded-lg transition-colors flex items-center justify-center gap-2"
                >
                  <ExternalLink className="w-4 h-4" />
                  Go to Schwab & Place Orders
                </button>

                <p className="text-xs text-gray-500 text-center">
                  You'll need to manually enter each order in Schwab.
                  <br />
                  Future versions will auto-submit directly to your broker.
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function getSuggestedSymbols(
  pillar: PillarType,
  action: 'BUY' | 'SELL',
  positions: EnrichedPosition[]
): string[] {
  const pillarSymbols: Record<PillarType, string[]> = {
    triples: ['UPRO', 'TQQQ', 'SPXL', 'UDOW'],
    cornerstone: ['CLM', 'CRF'],
    income: [
      'TSLY', 'NVDY', 'JEPI', 'JEPQ', 'QQQY', 'XDTE',
      'QQQ', 'SPY', 'TLT', 'AGG', 'SCHD',
    ],
    hedge: ['SPXU', 'SQQQ', 'SDOW', 'UVXY', 'SH', 'PSQ'],
    other: [],
  };

  const symbols = pillarSymbols[pillar] || [];

  if (action === 'SELL') {
    // Return symbols the user already owns in this pillar
    return symbols.filter((sym) =>
      positions.some(
        (pos) => pos.instrument.symbol.toUpperCase() === sym
      )
    );
  } else {
    // Return symbols the user doesn't own or owns least of
    const owned = new Set(
      positions
        .filter((p) => p.pillar === pillar)
        .map((p) => p.instrument.symbol.toUpperCase())
    );

    return symbols.filter((sym) => !owned.has(sym)).slice(0, 3);
  }
}

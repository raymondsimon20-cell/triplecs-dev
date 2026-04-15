'use client';

/**
 * Rebalance Calculator — computes exact shares to buy/sell to hit pillar targets.
 *
 * Applies the Vol 7 1/3 Rule automatically:
 *   When trimming income positions, route 1/3 of freed capital back into triples.
 *
 * Targets are editable; defaults come from strategy (Triples 30 / Cornerstone 10 / Income 60).
 */

import { useState, useMemo } from 'react';
import { Calculator, RefreshCw, TrendingUp, TrendingDown, Minus, AlertCircle } from 'lucide-react';
import type { EnrichedPosition, PillarType } from '@/lib/schwab/types';

interface PillarSummary {
  pillar: PillarType;
  label: string;
  totalValue: number;
  portfolioPercent: number;
  positionCount: number;
  dayGainLoss: number;
}

interface Props {
  positions: EnrichedPosition[];
  totalValue: number;
  equity: number;
  marginBalance: number;
  pillarSummary: PillarSummary[];
}

interface RebalanceAction {
  pillar: PillarType;
  label: string;
  currentValue: number;
  currentPct: number;
  targetPct: number;
  deltaDollars: number;       // positive = need to buy; negative = need to sell
  topCandidates: { symbol: string; value: number; price: number; suggestedShares: number }[];
  oneThirdNote?: string;      // 1/3 rule annotation
}

const DEFAULT_TARGETS: Record<PillarType, number> = {
  triples:     30,
  cornerstone: 10,
  income:      57,
  hedge:        3,
  other:        0,
};

const PILLAR_COLORS: Record<PillarType, string> = {
  triples:     'text-violet-400',
  cornerstone: 'text-amber-400',
  income:      'text-emerald-400',
  hedge:       'text-blue-400',
  other:       'text-[#7c82a0]',
};

const PILLAR_BAR: Record<PillarType, string> = {
  triples:     'bg-violet-500',
  cornerstone: 'bg-amber-500',
  income:      'bg-emerald-500',
  hedge:       'bg-blue-500',
  other:       'bg-[#4a5070]',
};

function fmt$(n: number) {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function getPrice(pos: EnrichedPosition): number {
  if (pos.longQuantity > 0) return pos.marketValue / pos.longQuantity;
  return pos.averagePrice || 1;
}

export function RebalanceCalculator({ positions, totalValue, pillarSummary }: Props) {
  const [open, setOpen] = useState(false);
  const [targets, setTargets] = useState<Record<PillarType, number>>({ ...DEFAULT_TARGETS });

  const visiblePillars: PillarType[] = ['triples', 'cornerstone', 'income', 'hedge'];

  const actions = useMemo((): RebalanceAction[] => {
    if (totalValue <= 0) return [];

    // 1/3 rule: if income is over target, 1/3 of income trim goes to triples
    const incomePs    = pillarSummary.find((p) => p.pillar === 'income');
    const triplesPs   = pillarSummary.find((p) => p.pillar === 'triples');
    const incomeCurr  = incomePs?.portfolioPercent  ?? 0;
    const triplesCurr = triplesPs?.portfolioPercent ?? 0;
    const incomeOver  = incomeCurr > targets.income;
    const incomeTrimDollars = incomeOver
      ? ((incomeCurr - targets.income) / 100) * totalValue
      : 0;
    const oneThirdBoost = incomeTrimDollars / 3;   // reroute to triples

    return visiblePillars.map((pillar) => {
      const ps     = pillarSummary.find((p) => p.pillar === pillar);
      const curr   = ps?.portfolioPercent ?? 0;
      const val    = ps?.totalValue ?? 0;
      const target = targets[pillar];

      // Adjust triples target upward by 1/3 of income trim if applicable
      const effectiveTarget = pillar === 'triples' && incomeOver
        ? target + (oneThirdBoost / totalValue) * 100
        : target;

      const deltaDollars = ((effectiveTarget - curr) / 100) * totalValue;

      // Top candidates: positions in this pillar sorted by value desc
      const pillarPositions = positions
        .filter((p) => p.pillar === pillar && p.longQuantity > 0)
        .sort((a, b) => b.marketValue - a.marketValue)
        .slice(0, 3);

      const topCandidates = pillarPositions.map((p) => {
        const price = getPrice(p);
        const suggestedShares = Math.abs(Math.round(Math.abs(deltaDollars) / pillarPositions.length / price));
        return {
          symbol: p.instrument?.symbol ?? 'UNKNOWN',
          value:  p.marketValue,
          price,
          suggestedShares: Math.max(1, suggestedShares),
        };
      });

      let oneThirdNote: string | undefined;
      if (pillar === 'triples' && incomeOver && oneThirdBoost > 500) {
        oneThirdNote = `+${fmt$(oneThirdBoost)} from 1/3 rule (income trim)`;
      }
      if (pillar === 'income' && incomeOver) {
        oneThirdNote = `Trim ${fmt$(incomeTrimDollars)} — route 1/3 (${fmt$(oneThirdBoost)}) to Triples`;
      }

      return {
        pillar,
        label:  ps?.label ?? pillar,
        currentValue: val,
        currentPct:   curr,
        targetPct:    target,
        deltaDollars,
        topCandidates,
        oneThirdNote,
      };
    });
  }, [targets, pillarSummary, positions, totalValue]);

  const totalTargetPct = visiblePillars.reduce((s, p) => s + targets[p], 0);
  const targetValid    = Math.abs(totalTargetPct - 100) < 0.5;

  const updateTarget = (pillar: PillarType, value: number) => {
    setTargets((prev) => ({ ...prev, [pillar]: Math.max(0, Math.min(100, value)) }));
  };

  const resetTargets = () => setTargets({ ...DEFAULT_TARGETS });

  return (
    <div className="bg-[#1a1d27] border border-[#2d3248] rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-5 py-4 hover:bg-[#20243a] transition-colors"
      >
        <div className="flex items-center gap-2.5">
          <Calculator className="w-5 h-5 text-violet-400" />
          <span className="font-semibold text-white text-sm">Rebalance Calculator</span>
          <span className="text-xs text-[#4a5070] bg-[#2d3248] px-2 py-0.5 rounded-full">1/3 rule</span>
        </div>
        <span className="text-[#7c82a0] text-xs">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="border-t border-[#2d3248] px-5 py-4 space-y-5">

          {/* Target inputs */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs font-semibold text-[#7c82a0] uppercase tracking-wide">Target Allocations</p>
              <button onClick={resetTargets} className="flex items-center gap-1 text-xs text-[#4a5070] hover:text-white transition-colors">
                <RefreshCw className="w-3 h-3" /> Reset to strategy defaults
              </button>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {visiblePillars.map((pillar) => (
                <div key={pillar} className="space-y-1">
                  <label className={`text-xs font-medium capitalize ${PILLAR_COLORS[pillar]}`}>
                    {pillar === 'triples' ? 'Triples (3×)' :
                     pillar === 'cornerstone' ? 'Cornerstone' :
                     pillar === 'income' ? 'Core / Income' : 'Hedge'}
                  </label>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={targets[pillar]}
                      onChange={(e) => updateTarget(pillar, parseFloat(e.target.value) || 0)}
                      className="w-full bg-[#0f1117] border border-[#2d3248] rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-violet-500/50"
                    />
                    <span className="text-sm text-[#7c82a0]">%</span>
                  </div>
                </div>
              ))}
            </div>
            {!targetValid && (
              <div className="flex items-center gap-1.5 mt-2 text-xs text-orange-400">
                <AlertCircle className="w-3.5 h-3.5" />
                Targets sum to {totalTargetPct.toFixed(1)}% — adjust to reach 100%
              </div>
            )}
          </div>

          {/* Action table */}
          <div className="space-y-3">
            <p className="text-xs font-semibold text-[#7c82a0] uppercase tracking-wide">Rebalance Actions</p>
            {actions.map((a) => {
              const needsBuy  = a.deltaDollars > 500;
              const needsSell = a.deltaDollars < -500;
              const atTarget  = !needsBuy && !needsSell;

              return (
                <div key={a.pillar} className={`bg-[#0f1117] border rounded-lg p-3 space-y-2 ${
                  needsBuy  ? 'border-emerald-500/25' :
                  needsSell ? 'border-orange-500/25' :
                              'border-[#2d3248]'
                }`}>
                  {/* Row header */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`text-xs font-semibold capitalize ${PILLAR_COLORS[a.pillar]}`}>
                      {a.pillar === 'triples' ? 'Triples (3×)' :
                       a.pillar === 'cornerstone' ? 'Cornerstone' :
                       a.pillar === 'income' ? 'Core / Income' : 'Hedge'}
                    </span>

                    <div className="flex-1 mx-2">
                      <div className="relative h-1.5 bg-[#2d3248] rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full ${PILLAR_BAR[a.pillar]}`}
                          style={{ width: `${Math.min(a.currentPct, 100)}%` }}
                        />
                        <div
                          className="absolute top-0 h-full w-0.5 bg-white/40"
                          style={{ left: `${Math.min(a.targetPct, 100)}%` }}
                        />
                      </div>
                    </div>

                    <span className="text-xs text-[#7c82a0]">
                      {a.currentPct.toFixed(1)}% <span className="text-[#4a5070]">→ {a.targetPct}% target</span>
                    </span>

                    {atTarget ? (
                      <span className="text-xs text-emerald-400 flex items-center gap-0.5"><Minus className="w-3 h-3" /> On target</span>
                    ) : needsBuy ? (
                      <span className="text-xs text-emerald-400 flex items-center gap-0.5">
                        <TrendingUp className="w-3.5 h-3.5" /> Buy {fmt$(a.deltaDollars)}
                      </span>
                    ) : (
                      <span className="text-xs text-orange-400 flex items-center gap-0.5">
                        <TrendingDown className="w-3.5 h-3.5" /> Trim {fmt$(Math.abs(a.deltaDollars))}
                      </span>
                    )}
                  </div>

                  {/* 1/3 rule note */}
                  {a.oneThirdNote && (
                    <div className="text-[10px] text-violet-300 bg-violet-500/10 border border-violet-500/20 rounded px-2 py-1">
                      📐 1/3 Rule: {a.oneThirdNote}
                    </div>
                  )}

                  {/* Candidate positions */}
                  {!atTarget && a.topCandidates.length > 0 && (
                    <div className="space-y-1">
                      {a.topCandidates.map((c) => (
                        <div key={c.symbol} className="flex items-center justify-between text-xs text-[#7c82a0]">
                          <span className="font-mono text-white">{c.symbol}</span>
                          <span>{fmt$(c.value)} held</span>
                          <span className="text-[#4a5070]">~{c.suggestedShares} sh @ ${c.price.toFixed(2)}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {!atTarget && a.topCandidates.length === 0 && (
                    <p className="text-xs text-[#4a5070]">No positions in this pillar — add new positions to reach target.</p>
                  )}
                </div>
              );
            })}
          </div>

          <p className="text-[10px] text-[#4a5070]">
            Share estimates are approximate. Always verify prices before placing orders. The 1/3 rule applies when trimming income positions per Vol 7.
          </p>
        </div>
      )}
    </div>
  );
}

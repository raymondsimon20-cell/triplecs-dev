'use client';

/**
 * Hedge Pair Tracker — Vol 7 hedged position monitor.
 *
 * Vol 7 pairs each bullish 3× ETF with its bearish inverse counterpart:
 *   SPXL ↔ SPXU  (S&P 500 3×)
 *   TQQQ ↔ SQQQ  (Nasdaq 3×)
 *   UDOW ↔ SDOW  (Dow 3×)
 *   SOXL ↔ SOXS  (Semiconductors 3×)
 *   FNGU ↔ FNGD  (FAANG+ 3×)
 *   NVDY ↔ DIPS  (Nvidia income ↔ inverse)
 *   TSLY ↔ CRSH  (Tesla income ↔ inverse)
 *
 * Straddle: roughly equal dollar weight on both sides.
 * Strangle: asymmetric — tilt toward bull in uptrend, bear in downtrend.
 *
 * Shows: each pair's bull value, bear value, ratio, tilt classification.
 */

import { useState, useMemo } from 'react';
import { Shield, ChevronDown, ChevronUp, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import type { EnrichedPosition } from '@/lib/schwab/types';

interface Props {
  positions: EnrichedPosition[];
}

interface HedgePair {
  label:     string;
  bullSym:   string;
  bearSym:   string;
  bullValue: number;
  bearValue: number;
  bullShares: number;
  bearShares: number;
  bullPrice: number;
  bearPrice: number;
  total:     number;
  ratio:     number;     // bullValue / total, 0–1
  tilt:      'straddle' | 'bull' | 'bear' | 'bull_only' | 'bear_only' | 'unhedged';
}

const PAIRS: { label: string; bull: string; bear: string }[] = [
  { label: 'S&P 500 3×',       bull: 'SPXL', bear: 'SPXU' },
  { label: 'Nasdaq 3×',        bull: 'TQQQ', bear: 'SQQQ' },
  { label: 'Dow 3×',           bull: 'UDOW', bear: 'SDOW' },
  { label: 'Semiconductors 3×', bull: 'SOXL', bear: 'SOXS' },
  { label: 'FAANG+ 3×',        bull: 'FNGU', bear: 'FNGD' },
  { label: 'Nvidia Income',    bull: 'NVDY', bear: 'DIPS' },
  { label: 'Tesla Income',     bull: 'TSLY', bear: 'CRSH' },
];

function fmt$(n: number) {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function findPos(positions: EnrichedPosition[], symbol: string): EnrichedPosition | undefined {
  return positions.find((p) => p.instrument?.symbol?.toUpperCase() === symbol);
}

function classifyTilt(ratio: number, total: number): HedgePair['tilt'] {
  if (total === 0) return 'unhedged';
  if (ratio === 1) return 'bull_only';
  if (ratio === 0) return 'bear_only';
  if (ratio >= 0.42 && ratio <= 0.58) return 'straddle';
  return ratio > 0.5 ? 'bull' : 'bear';
}

const TILT_STYLE: Record<HedgePair['tilt'], { label: string; color: string }> = {
  straddle:  { label: 'Straddle',   color: 'bg-violet-500/20 text-violet-300 border-violet-500/30' },
  bull:      { label: 'Bull tilt',  color: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30' },
  bear:      { label: 'Bear tilt',  color: 'bg-orange-500/20 text-orange-300 border-orange-500/30' },
  bull_only: { label: 'Bull only',  color: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30' },
  bear_only: { label: 'Bear only',  color: 'bg-red-500/20 text-red-300 border-red-500/30' },
  unhedged:  { label: 'Not held',   color: 'bg-[#2d3248] text-[#4a5070] border-[#3d4260]' },
};

export function HedgePairTracker({ positions }: Props) {
  const [open, setOpen] = useState(false);

  const pairs = useMemo((): HedgePair[] => {
    return PAIRS.map(({ label, bull, bear }) => {
      const bullPos   = findPos(positions, bull);
      const bearPos   = findPos(positions, bear);
      const bullValue = bullPos?.marketValue ?? 0;
      const bearValue = bearPos?.marketValue ?? 0;
      const bullShares = bullPos?.longQuantity ?? 0;
      const bearShares = bearPos?.longQuantity ?? 0;
      const bullPrice  = bullShares > 0 ? bullValue / bullShares : 0;
      const bearPrice  = bearShares > 0 ? bearValue / bearShares : 0;
      const total     = bullValue + bearValue;
      const ratio     = total > 0 ? bullValue / total : 0;
      const tilt      = classifyTilt(ratio, total);

      return { label, bullSym: bull, bearSym: bear, bullValue, bearValue, bullShares, bearShares, bullPrice, bearPrice, total, ratio, tilt };
    }).filter((p) => p.total > 0)
      .sort((a, b) => b.total - a.total);
  }, [positions]);

  const heldCount     = pairs.length;
  const straddleCount = pairs.filter((p) => p.tilt === 'straddle').length;
  const totalHedged   = pairs.reduce((s, p) => s + p.total, 0);

  // Pairs not yet held at all
  const unheldPairs = PAIRS.filter(
    ({ bull, bear }) => !findPos(positions, bull) && !findPos(positions, bear),
  );

  return (
    <div className="bg-[#1a1d27] border border-[#2d3248] rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-5 py-4 hover:bg-[#20243a] transition-colors"
      >
        <div className="flex items-center gap-2.5">
          <Shield className="w-5 h-5 text-blue-400" />
          <span className="font-semibold text-white text-sm">Hedge Pair Tracker</span>
          {heldCount > 0 ? (
            <span className="text-xs text-blue-300 bg-blue-500/10 px-2 py-0.5 rounded-full">
              {heldCount} pair{heldCount !== 1 ? 's' : ''} · {straddleCount} straddle{straddleCount !== 1 ? 's' : ''}
            </span>
          ) : (
            <span className="text-xs text-[#4a5070] bg-[#2d3248] px-2 py-0.5 rounded-full">No hedge pairs held</span>
          )}
        </div>
        {open ? <ChevronUp className="w-4 h-4 text-[#7c82a0]" /> : <ChevronDown className="w-4 h-4 text-[#7c82a0]" />}
      </button>

      {open && (
        <div className="border-t border-[#2d3248] px-5 py-4 space-y-4">

          {heldCount === 0 ? (
            <div className="text-center py-6 space-y-2">
              <Shield className="w-8 h-8 text-[#2d3248] mx-auto" />
              <p className="text-sm text-[#4a5070]">No hedge pairs detected.</p>
              <p className="text-xs text-[#3d4260]">
                Vol 7 pairs: SPXL/SPXU · TQQQ/SQQQ · UDOW/SDOW · SOXL/SOXS · FNGU/FNGD · NVDY/DIPS · TSLY/CRSH
              </p>
            </div>
          ) : (
            <>
              {/* Total hedged */}
              <div className="bg-[#0f1117] border border-[#2d3248] rounded-lg p-3 flex items-center justify-between">
                <div>
                  <div className="text-[10px] text-[#7c82a0] mb-0.5">Total in Hedge Pairs</div>
                  <div className="text-sm font-bold text-white">{fmt$(totalHedged)}</div>
                </div>
                <div className="text-right">
                  <div className="text-[10px] text-[#7c82a0] mb-0.5">Strategy</div>
                  <div className="text-xs text-[#7c82a0]">
                    Straddle ≈ equal weight · Strangle = market tilt
                  </div>
                </div>
              </div>

              {/* Pair rows */}
              <div className="space-y-3">
                {pairs.map((p) => {
                  const cfg          = TILT_STYLE[p.tilt];
                  const bullBarWidth = p.total > 0 ? (p.bullValue / p.total) * 100 : 0;

                  return (
                    <div key={`${p.bullSym}-${p.bearSym}`} className="bg-[#0f1117] border border-[#2d3248] rounded-lg p-3 space-y-2.5">

                      {/* Header row */}
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-white flex-1">{p.label}</span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded border ${cfg.color}`}>{cfg.label}</span>
                        <span className="text-xs font-mono text-[#7c82a0] ml-1">{fmt$(p.total)}</span>
                      </div>

                      {/* Bull / Bear split bar */}
                      <div className="relative h-3 bg-red-500/30 rounded-full overflow-hidden">
                        <div
                          className="absolute left-0 top-0 h-full bg-emerald-500/70 rounded-l-full transition-all"
                          style={{ width: `${bullBarWidth}%` }}
                        />
                        {/* Midpoint marker */}
                        <div className="absolute top-0 left-1/2 h-full w-px bg-[#7c82a0]/40" />
                      </div>

                      {/* Bull / Bear detail */}
                      <div className="grid grid-cols-2 gap-2">
                        <div className="flex items-center gap-1.5">
                          <TrendingUp className="w-3 h-3 text-emerald-400 flex-shrink-0" />
                          <div>
                            <div className="text-[10px] font-mono font-semibold text-emerald-300">
                              {p.bullSym}
                              {p.bullShares > 0 && <span className="text-emerald-300/60 ml-1">×{p.bullShares}</span>}
                            </div>
                            <div className="text-[10px] text-emerald-400/70">
                              {p.bullValue > 0 ? fmt$(p.bullValue) : '—'}
                              {p.bullPrice > 0 && <span className="text-[#4a5070] ml-1">@ ${p.bullPrice.toFixed(2)}</span>}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <TrendingDown className="w-3 h-3 text-red-400 flex-shrink-0" />
                          <div>
                            <div className="text-[10px] font-mono font-semibold text-red-300">
                              {p.bearSym}
                              {p.bearShares > 0 && <span className="text-red-300/60 ml-1">×{p.bearShares}</span>}
                            </div>
                            <div className="text-[10px] text-red-400/70">
                              {p.bearValue > 0 ? fmt$(p.bearValue) : '—'}
                              {p.bearPrice > 0 && <span className="text-[#4a5070] ml-1">@ ${p.bearPrice.toFixed(2)}</span>}
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Ratio label */}
                      <div className="flex items-center gap-1 text-[10px] text-[#4a5070]">
                        <Minus className="w-3 h-3" />
                        <span>
                          Bull {p.total > 0 ? (p.bullValue / p.total * 100).toFixed(0) : 0}% ·{' '}
                          Bear {p.total > 0 ? (p.bearValue / p.total * 100).toFixed(0) : 0}%
                          {p.tilt === 'straddle' && <span className="text-violet-400 ml-1">— balanced straddle</span>}
                          {p.tilt === 'bull'     && <span className="text-emerald-400 ml-1">— tilted bull (reduce bear or add bear to balance)</span>}
                          {p.tilt === 'bear'     && <span className="text-orange-400 ml-1">— tilted bear (add bull or reduce bear to balance)</span>}
                          {p.tilt === 'bull_only' && <span className="text-emerald-400 ml-1">— unhedged bull (add {p.bearSym} to create straddle)</span>}
                          {p.tilt === 'bear_only' && <span className="text-red-400 ml-1">— unhedged bear (add {p.bullSym} to create straddle)</span>}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Unheld pairs */}
              {unheldPairs.length > 0 && (
                <div className="text-[10px] text-[#4a5070] bg-[#0f1117] border border-[#2d3248] rounded px-3 py-2">
                  <span className="text-[#7c82a0]">Pairs not yet started: </span>
                  {unheldPairs.map(({ bull, bear }) => `${bull}/${bear}`).join(' · ')}
                </div>
              )}
            </>
          )}

          <p className="text-[10px] text-[#4a5070]">
            Vol 7: Hold bull+bear pairs in each sector. Straddle = equal weight. Strangle = tilt toward market direction.
            Hedge minimum 1% of portfolio per pair.
          </p>
        </div>
      )}
    </div>
  );
}

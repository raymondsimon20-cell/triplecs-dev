'use client';

/**
 * YMAG DRIP Tracker — Vol 7 YMAG strategy monitor.
 *
 * YMAG = YieldMax Magnificent 7 option income ETF (monthly distributions).
 * Vol 7 rule: enroll in DRIP to auto-compound the yield.
 * FNGA/FNGB pairing: when YMAG distributions trigger capital gains events,
 *   the gain is offset by holding FNGA (Direxion FAANG+) or FNGB alongside.
 *
 * This component shows:
 *   • Current YMAG position (shares, value, avg cost, unrealised P&L)
 *   • Estimated monthly/annual distribution
 *   • FNGA/FNGB hedge pair if held (dollar offset to YMAG capital gains)
 *   • DRIP toggle reminder (manual — Schwab DRIP must be set in brokerage)
 */

import { useState, useMemo } from 'react';
import { RefreshCw, ChevronDown, ChevronUp, TrendingUp, DollarSign, Info } from 'lucide-react';
import type { EnrichedPosition } from '@/lib/schwab/types';

interface Props {
  positions: EnrichedPosition[];
}

const YMAG_FALLBACK_YIELD = 35; // ~35% trailing annual distribution yield
const FNGA_SYMBOLS = ['FNGA', 'FNGB', 'FNGU', 'FNGD'];

function fmt$(n: number) {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}
function fmt2$(n: number) {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtPct(n: number) {
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
}

function findPosition(positions: EnrichedPosition[], symbol: string): EnrichedPosition | undefined {
  return positions.find((p) => p.instrument?.symbol?.toUpperCase() === symbol);
}

export function YmagDripTracker({ positions }: Props) {
  const [open, setOpen] = useState(false);

  const { ymag, fngPairs, monthlyEst, annualEst, totalFngValue } = useMemo(() => {
    const ymag = findPosition(positions, 'YMAG');

    const fngPairs = FNGA_SYMBOLS
      .map((sym) => findPosition(positions, sym))
      .filter((p): p is EnrichedPosition => p != null);

    const totalFngValue = fngPairs.reduce((s, p) => s + p.marketValue, 0);

    if (!ymag) return { ymag: null, fngPairs, monthlyEst: 0, annualEst: 0, totalFngValue };

    const yieldPct = ymag.quote?.divYield && ymag.quote.divYield > 0
      ? ymag.quote.divYield
      : YMAG_FALLBACK_YIELD;

    const annualEst   = ymag.marketValue * (yieldPct / 100);
    const monthlyEst  = annualEst / 12;

    return { ymag, fngPairs, monthlyEst, annualEst, totalFngValue };
  }, [positions]);

  const hasYmag = ymag != null;

  const ymagValue   = ymag?.marketValue ?? 0;
  const ymagShares  = ymag?.longQuantity ?? 0;
  const ymagAvgCost = ymag?.averagePrice ?? 0;
  const ymagPrice   = ymagShares > 0 ? ymagValue / ymagShares : 0;
  const unrealisedPct = ymagAvgCost > 0 ? ((ymagPrice - ymagAvgCost) / ymagAvgCost) * 100 : 0;
  const unrealisedAmt = (ymagPrice - ymagAvgCost) * ymagShares;

  // Hedge coverage: FNGA/B value vs YMAG value
  const hedgePct = ymagValue > 0 ? (totalFngValue / ymagValue) * 100 : 0;

  return (
    <div className="bg-[#1a1d27] border border-[#2d3248] rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-5 py-4 hover:bg-[#20243a] transition-colors"
      >
        <div className="flex items-center gap-2.5">
          <RefreshCw className="w-5 h-5 text-violet-400" />
          <span className="font-semibold text-white text-sm">YMAG DRIP Tracker</span>
          {hasYmag ? (
            <span className="text-xs text-violet-300 bg-violet-500/10 px-2 py-0.5 rounded-full">
              {fmt$(ymagValue)} · ~{fmt$(monthlyEst)}/mo
            </span>
          ) : (
            <span className="text-xs text-[#4a5070] bg-[#2d3248] px-2 py-0.5 rounded-full">No YMAG position</span>
          )}
        </div>
        {open ? <ChevronUp className="w-4 h-4 text-[#7c82a0]" /> : <ChevronDown className="w-4 h-4 text-[#7c82a0]" />}
      </button>

      {open && (
        <div className="border-t border-[#2d3248] px-5 py-4 space-y-4">
          {!hasYmag ? (
            <div className="text-center py-6 space-y-2">
              <RefreshCw className="w-8 h-8 text-[#2d3248] mx-auto" />
              <p className="text-sm text-[#4a5070]">No YMAG position found.</p>
              <p className="text-xs text-[#3d4260]">
                Vol 7: YMAG is the core income compounder — buy on down days, enroll in DRIP.
              </p>
            </div>
          ) : (
            <>
              {/* Position summary */}
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-[#0f1117] border border-[#2d3248] rounded-lg p-3">
                  <div className="text-[10px] text-[#7c82a0] mb-1">Market Value</div>
                  <div className="text-sm font-bold text-white">{fmt$(ymagValue)}</div>
                  <div className="text-[10px] text-[#7c82a0] mt-1">{ymagShares.toLocaleString()} shares @ {fmt2$(ymagPrice)}</div>
                </div>
                <div className="bg-[#0f1117] border border-[#2d3248] rounded-lg p-3">
                  <div className="text-[10px] text-[#7c82a0] mb-1">Unrealised P&L</div>
                  <div className={`text-sm font-bold ${unrealisedAmt >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {fmt2$(unrealisedAmt)}
                  </div>
                  <div className={`text-[10px] mt-1 ${unrealisedAmt >= 0 ? 'text-emerald-400/70' : 'text-red-400/70'}`}>
                    {fmtPct(unrealisedPct)} vs avg {fmt2$(ymagAvgCost)}
                  </div>
                </div>
              </div>

              {/* Distribution estimate */}
              <div className="bg-violet-500/10 border border-violet-500/20 rounded-lg p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <DollarSign className="w-4 h-4 text-violet-400" />
                  <span className="text-xs font-semibold text-violet-300">Estimated Distributions</span>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <div className="text-[10px] text-violet-400/70 mb-0.5">Monthly</div>
                    <div className="text-base font-bold text-violet-300">{fmt$(monthlyEst)}</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-violet-400/70 mb-0.5">Annual</div>
                    <div className="text-base font-bold text-violet-300">{fmt$(annualEst)}</div>
                  </div>
                </div>
                <p className="text-[10px] text-violet-400/60">
                  Based on ~{YMAG_FALLBACK_YIELD}% trailing yield. Actual distributions vary monthly.
                </p>
              </div>

              {/* DRIP reminder */}
              <div className="flex items-start gap-2.5 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2.5">
                <Info className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
                <div className="text-xs text-amber-300 space-y-1">
                  <div className="font-semibold">DRIP Reminder</div>
                  <div>
                    Vol 7: Enroll YMAG in DRIP via Schwab to auto-reinvest distributions into more YMAG shares.
                    Compounds the yield over time without requiring manual reinvestment.
                  </div>
                </div>
              </div>

              {/* FNGA/FNGB pairing */}
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <TrendingUp className="w-3.5 h-3.5 text-blue-400" />
                  <span className="text-xs font-semibold text-[#7c82a0]">FNGA/FNGB Capital Gains Offset</span>
                  <span className={`ml-auto text-[10px] px-1.5 py-0.5 rounded ${
                    totalFngValue > 0
                      ? 'bg-blue-500/20 text-blue-300'
                      : 'bg-[#2d3248] text-[#4a5070]'
                  }`}>
                    {totalFngValue > 0 ? `${hedgePct.toFixed(0)}% coverage` : 'Not held'}
                  </span>
                </div>

                {fngPairs.length > 0 ? (
                  <div className="space-y-1.5">
                    {fngPairs.map((p) => {
                      const sym   = p.instrument.symbol.toUpperCase();
                      const price = p.longQuantity > 0 ? p.marketValue / p.longQuantity : 0;
                      const pct   = ymagValue > 0 ? (p.marketValue / ymagValue) * 100 : 0;
                      return (
                        <div key={sym} className="flex items-center gap-3 bg-[#0f1117] border border-[#2d3248] rounded px-3 py-2">
                          <span className="text-xs font-mono font-bold text-white w-12">{sym}</span>
                          <span className="text-[10px] text-[#7c82a0] flex-1">{p.longQuantity} shares @ {fmt2$(price)}</span>
                          <span className="text-xs font-mono text-blue-400">{fmt$(p.marketValue)}</span>
                          <span className="text-[10px] text-[#4a5070]">{pct.toFixed(0)}%</span>
                        </div>
                      );
                    })}
                    <p className="text-[10px] text-[#4a5070] pt-1">
                      Vol 7: FNGA/FNGB held alongside YMAG to offset capital gains distributions — sell if YMAG
                      generates a large short-term gain event.
                    </p>
                  </div>
                ) : (
                  <p className="text-[10px] text-[#4a5070] bg-[#0f1117] border border-[#2d3248] rounded px-3 py-2">
                    No FNGA or FNGB held. Consider adding to offset YMAG capital gains events per Vol 7.
                  </p>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

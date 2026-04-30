'use client';

/**
 * PutChainInline — fetches and displays the live put options chain for a
 * given ticker, inline in the AI Trade Plan recommendations.
 *
 * Highlights the Vol 6 "sweet spot" contracts:
 *   - DTE between 60–120 (LEAP-ish)
 *   - OTM 5–20%
 *   - Shows 75% close target and annualised return
 */

import { useState } from 'react';
import { ChevronDown, ChevronUp, Loader2, AlertTriangle, TrendingDown, Sparkles, CheckCircle2 } from 'lucide-react';
import { fetchOptionPlan, type OptionPlanResponse } from '@/lib/option-plan-client';

interface PutContract {
  symbol:           string;
  expiration:       string;
  dte:              number;
  strike:           number;
  bid:              number;
  ask:              number;
  mid:              number;
  iv:               number;
  delta:            number;
  openInterest:     number;
  otmPct:           number;
  breakeven:        number;
  closeTarget75:    number;
  annualisedReturn: number;
  inTheMoney:       boolean;
}

interface ChainData {
  symbol:          string;
  underlyingPrice: number;
  puts:            PutContract[];
  fetchedAt:       string;
}

interface PutChainInlineProps {
  ticker: string;
  /**
   * When provided, surfaces a "Pick best & stage" button that calls
   * /api/option-plan in the given mode. The endpoint auto-stages the
   * selected contract into the Trade Inbox, so success means the trade
   * is queued for one-click approval — no further action required.
   */
  stageMode?: 'sell_put' | 'buy_put';
}

function fmt2(n: number) { return n.toFixed(2); }
// Simple % display without sign prefix (not the same as fmtPct from utils)
function fmtPct(n: number) { return `${n.toFixed(1)}%`; }

function isSweetSpot(p: PutContract): boolean {
  return p.dte >= 45 && p.dte <= 150 && p.otmPct >= 5 && p.otmPct <= 25 && !p.inTheMoney;
}

/** Delta sweet spot for put selling: −0.20 to −0.35 */
function isDeltaSweetSpot(p: PutContract): boolean {
  const abs = Math.abs(p.delta);
  return abs >= 0.18 && abs <= 0.38;
}

/** Probability of profit ≈ 1 − |delta| (rough heuristic) */
function probOfProfit(p: PutContract): number {
  if (!p.delta) return 0;
  return Math.round((1 - Math.abs(p.delta)) * 100);
}

export function PutChainInline({ ticker, stageMode }: PutChainInlineProps) {
  const [open,    setOpen]    = useState(false);
  const [loading, setLoading] = useState(false);
  const [data,    setData]    = useState<ChainData | null>(null);
  const [error,   setError]   = useState<string | null>(null);
  const [filter,  setFilter]  = useState<'sweet_spot' | 'all'>('sweet_spot');

  // AI-pick state — only used when stageMode is set.
  const [picking,    setPicking]   = useState(false);
  const [plan,       setPlan]      = useState<OptionPlanResponse | null>(null);
  const [planError,  setPlanError] = useState<string | null>(null);

  const pickAndStage = async () => {
    if (!stageMode) return;
    setPicking(true);
    setPlanError(null);
    try {
      const result = await fetchOptionPlan({ symbol: ticker, mode: stageMode, contracts: 1 });
      setPlan(result);
    } catch (e) {
      setPlanError(e instanceof Error ? e.message : 'Failed to pick contract');
    } finally {
      setPicking(false);
    }
  };

  const fetch_ = async () => {
    if (data) { setOpen((v) => !v); return; }  // toggle if already loaded
    setOpen(true);
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/options-chain?symbol=${encodeURIComponent(ticker)}&strikeCount=20`);
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.error ?? `HTTP ${res.status}`);
      }
      const json = await res.json() as ChainData;
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load chain');
    } finally {
      setLoading(false);
    }
  };

  const displayed = data?.puts.filter((p) =>
    filter === 'sweet_spot' ? isSweetSpot(p) : !p.inTheMoney
  ) ?? [];

  // Group by expiration
  const byExp: Record<string, PutContract[]> = {};
  for (const p of displayed) {
    if (!byExp[p.expiration]) byExp[p.expiration] = [];
    byExp[p.expiration].push(p);
  }

  return (
    <div className="mt-2 space-y-2">
      {stageMode && (
        <div className="space-y-1.5">
          {!plan && (
            <button
              onClick={pickAndStage}
              disabled={picking}
              className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded bg-purple-500/15 border border-purple-500/40 text-purple-300 hover:bg-purple-500/25 disabled:opacity-50 transition-colors font-semibold"
            >
              {picking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
              {picking ? 'AI picking best contract…' : `✨ AI-pick best ${stageMode === 'sell_put' ? 'sell-put' : 'protective put'} & stage to Inbox`}
            </button>
          )}

          {planError && (
            <div className="flex items-center gap-1.5 text-xs text-red-400">
              <AlertTriangle className="w-3.5 h-3.5" /> {planError}
            </div>
          )}

          {plan && (
            <div className="bg-emerald-500/10 border border-emerald-500/40 rounded px-3 py-2 text-xs space-y-1">
              <div className="flex items-center gap-1.5 text-emerald-300 font-semibold">
                <CheckCircle2 className="w-3.5 h-3.5" /> Staged to Inbox
              </div>
              <div className="font-mono text-[#e8eaf0]">
                {plan.instruction === 'SELL_TO_OPEN' ? 'SELL' : 'BUY'} {plan.contracts} × {plan.symbol}{' '}
                ${plan.selectedContract.strike.toFixed(2)}P{' '}
                {plan.selectedContract.expiration} ({plan.selectedContract.dte}d) @ ${plan.limitPrice.toFixed(2)} limit
              </div>
              <div className="text-[#7c82a0] text-[11px]">
                Δ {plan.selectedContract.delta.toFixed(2)} · OTM {plan.selectedContract.otmPct.toFixed(1)}%
                {' · '}Ann.Ret {plan.selectedContract.annualisedReturn.toFixed(1)}%
                {' · '}Breakeven ${plan.selectedContract.breakeven.toFixed(2)}
              </div>
              <div className="text-[#a8aec8] text-[11px] italic leading-relaxed pt-0.5">{plan.rationale}</div>
              {!plan.validationPassed && (
                <div className="text-amber-400 text-[10px] pt-0.5">
                  ⚠ AI selection fell back to scored pick — review carefully.
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <button
        onClick={fetch_}
        className="flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 transition-colors"
      >
        <TrendingDown className="w-3.5 h-3.5" />
        {open ? 'Hide' : 'View'} put chain for {ticker}
        {open ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
      </button>

      {open && (
        <div className="mt-2 bg-[#0a0d15] border border-[#2d3248] rounded-lg overflow-hidden">
          {loading && (
            <div className="flex items-center gap-2 px-4 py-3 text-xs text-[#7c82a0]">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading chain…
            </div>
          )}

          {error && (
            <div className="flex items-center gap-2 px-4 py-3 text-xs text-red-400">
              <AlertTriangle className="w-3.5 h-3.5" /> {error}
            </div>
          )}

          {data && !loading && (
            <>
              {/* Header */}
              <div className="flex items-center justify-between px-4 py-2.5 border-b border-[#2d3248]">
                <div className="text-xs text-[#7c82a0]">
                  <span className="font-semibold text-white">{data.symbol}</span>
                  <span className="ml-2">@ ${fmt2(data.underlyingPrice)}</span>
                </div>
                <div className="flex gap-1">
                  {(['sweet_spot', 'all'] as const).map((f) => (
                    <button
                      key={f}
                      onClick={() => setFilter(f)}
                      className={`text-[10px] px-2 py-0.5 rounded transition-colors ${
                        filter === f
                          ? 'bg-blue-600 text-white'
                          : 'text-[#4a5070] hover:text-white border border-[#3d4260]'
                      }`}
                    >
                      {f === 'sweet_spot' ? '45–150 DTE / 5–25% OTM' : 'All OTM'}
                    </button>
                  ))}
                </div>
              </div>

              {/* Vol 6 reminder */}
              <div className="px-4 py-2 text-[10px] text-[#4a5070] border-b border-[#2d3248] flex flex-wrap gap-x-4 gap-y-0.5">
                <span>Vol 6: LEAP puts (45–150 DTE) · Close at 75% profit · Sell on down days</span>
                <span className="text-violet-300">Δ sweet spot: −0.20 to −0.35 · ~65–80% PoP</span>
              </div>

              {/* Contracts by expiry */}
              {Object.keys(byExp).length === 0 ? (
                <div className="px-4 py-3 text-xs text-[#4a5070]">
                  No contracts match filter. Try switching to "All OTM".
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-[#2d3248] text-[#4a5070]">
                        <th className="text-left px-3 py-2 font-medium">Exp / DTE</th>
                        <th className="text-right px-2 py-2 font-medium">Strike</th>
                        <th className="text-right px-2 py-2 font-medium">OTM%</th>
                        <th className="text-right px-2 py-2 font-medium">Delta</th>
                        <th className="text-right px-2 py-2 font-medium">PoP</th>
                        <th className="text-right px-2 py-2 font-medium">Mid</th>
                        <th className="text-right px-2 py-2 font-medium">Close@75%</th>
                        <th className="text-right px-2 py-2 font-medium">Breakeven</th>
                        <th className="text-right px-2 py-2 font-medium">Ann. Ret</th>
                        <th className="text-right px-3 py-2 font-medium">IV</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(byExp).flatMap(([exp, contracts]) =>
                        contracts.map((p, i) => {
                          const sweet      = isSweetSpot(p);
                          const deltaSweet = isDeltaSweetSpot(p);
                          const pop        = probOfProfit(p);
                          const ideal      = sweet && deltaSweet;
                          return (
                            <tr
                              key={p.symbol}
                              className={`border-b border-[#1a1d27] ${
                                ideal  ? 'bg-violet-500/8' :
                                sweet  ? 'bg-blue-500/5' : 'hover:bg-[#0f1117]'
                              }`}
                            >
                              {i === 0 ? (
                                <td
                                  className="px-3 py-2 text-[#7c82a0] font-mono whitespace-nowrap"
                                  rowSpan={contracts.length}
                                >
                                  {exp}<br/>
                                  <span className="text-[#4a5070]">{p.dte}d</span>
                                </td>
                              ) : null}
                              <td className="text-right px-2 py-2 font-mono text-white">${fmt2(p.strike)}</td>
                              <td className={`text-right px-2 py-2 font-mono ${p.otmPct >= 5 && p.otmPct <= 25 ? 'text-blue-300' : 'text-[#7c82a0]'}`}>
                                {fmtPct(p.otmPct)}
                              </td>
                              <td className={`text-right px-2 py-2 font-mono ${
                                deltaSweet ? 'text-violet-300 font-semibold' : 'text-[#7c82a0]'
                              }`}>
                                {p.delta ? p.delta.toFixed(2) : '—'}
                                {ideal && <span className="ml-1 text-[9px] text-violet-400">★</span>}
                              </td>
                              <td className={`text-right px-2 py-2 font-mono ${
                                pop >= 70 ? 'text-emerald-400' : pop >= 60 ? 'text-blue-400' : 'text-[#7c82a0]'
                              }`}>
                                {pop > 0 ? `${pop}%` : '—'}
                              </td>
                              <td className="text-right px-2 py-2 font-mono text-emerald-400 font-semibold">${fmt2(p.mid)}</td>
                              <td className="text-right px-2 py-2 font-mono text-orange-400">${fmt2(p.closeTarget75)}</td>
                              <td className="text-right px-2 py-2 font-mono text-[#7c82a0]">${fmt2(p.breakeven)}</td>
                              <td className={`text-right px-2 py-2 font-mono font-semibold ${
                                p.annualisedReturn >= 20 ? 'text-emerald-400' :
                                p.annualisedReturn >= 10 ? 'text-blue-400' : 'text-[#7c82a0]'
                              }`}>
                                {fmtPct(p.annualisedReturn)}
                              </td>
                              <td className="text-right px-3 py-2 font-mono text-[#7c82a0]">{fmtPct(p.iv)}</td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

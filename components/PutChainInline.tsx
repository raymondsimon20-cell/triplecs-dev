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
import { ChevronDown, ChevronUp, Loader2, AlertTriangle, TrendingDown } from 'lucide-react';

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
}

function fmt2(n: number) { return n.toFixed(2); }
function fmtPct(n: number) { return `${n.toFixed(1)}%`; }

function isSweetSpot(p: PutContract): boolean {
  return p.dte >= 45 && p.dte <= 150 && p.otmPct >= 5 && p.otmPct <= 25 && !p.inTheMoney;
}

export function PutChainInline({ ticker }: PutChainInlineProps) {
  const [open,    setOpen]    = useState(false);
  const [loading, setLoading] = useState(false);
  const [data,    setData]    = useState<ChainData | null>(null);
  const [error,   setError]   = useState<string | null>(null);
  const [filter,  setFilter]  = useState<'sweet_spot' | 'all'>('sweet_spot');

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
    <div className="mt-2">
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
              <div className="px-4 py-2 text-[10px] text-[#4a5070] border-b border-[#2d3248]">
                Vol 6 rules: LEAP puts (45–150 DTE) · Close at 75% profit (when mid = Close Target) · Sell on down days
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
                        <th className="text-right px-2 py-2 font-medium">Bid</th>
                        <th className="text-right px-2 py-2 font-medium">Ask</th>
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
                          const sweet = isSweetSpot(p);
                          return (
                            <tr
                              key={p.symbol}
                              className={`border-b border-[#1a1d27] ${
                                sweet ? 'bg-blue-500/5' : 'hover:bg-[#0f1117]'
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
                              <td className="text-right px-2 py-2 font-mono text-[#7c82a0]">${fmt2(p.bid)}</td>
                              <td className="text-right px-2 py-2 font-mono text-[#7c82a0]">${fmt2(p.ask)}</td>
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

'use client';

/**
 * Open Put Position Tracker — Vol 6 put selling monitor.
 *
 * Filters OPTION positions from Schwab, parses OCC symbols to extract:
 *   underlying, expiration date, strike, DTE
 *
 * Highlights:
 *   • Contracts at ≥ 75% profit  → green "Close Now" badge
 *   • Contracts with DTE < 21    → orange expiration warning
 *   • Shows 75% close target premium for each contract
 *
 * OCC symbol format: "TSLA  250117P00200000"
 *   chars  0–5  : underlying (space-padded)
 *   chars  6–11 : YYMMDD (expiration)
 *   char   12   : P or C
 *   chars 13–20 : strike * 1000 (8 digits, zero-padded)
 */

import { useState } from 'react';
import { TrendingDown, ChevronDown, ChevronUp, AlertTriangle, CheckCircle, Clock, Loader2, X, RotateCw } from 'lucide-react';
import type { EnrichedPosition } from '@/lib/schwab/types';
import { fetchOptionPlan } from '@/lib/option-plan-client';

interface ParsedPut {
  symbol:         string;   // full OCC symbol
  underlying:     string;
  expiration:     string;   // YYYY-MM-DD
  dte:            number;
  strike:         number;
  quantity:       number;   // contracts short
  avgCost:        number;   // premium received per share (×100 for per-contract)
  currentValue:   number;   // cost to close (absolute value)
  premiumReceived:number;   // original premium collected
  currentPremium: number;   // current cost to close per contract
  profitPct:      number;   // % of premium captured (positive = profit)
  closeTarget75:  number;   // close when cost-to-close ≤ 25% of original
  status:         'close_now' | 'roll' | 'profitable' | 'neutral' | 'losing' | 'expiry_warning';
}

interface Props {
  positions: EnrichedPosition[];
}

function parseOCC(symbol: string): { underlying: string; expiration: string; isCall: boolean; strike: number } | null {
  // Remove spaces and try to match OCC format
  // Typical raw symbol: "TSLA  250117P00200000" (21 chars) or compressed "TSLA250117P00200000"
  const clean = symbol.replace(/\s+/g, '');

  // Match: underlying + 6-digit date + P/C + 8-digit strike
  const m = clean.match(/^([A-Z]+)(\d{6})([PC])(\d{8})$/i);
  if (!m) return null;

  const [, under, dateStr, type, strikeStr] = m;
  const yy  = parseInt(dateStr.slice(0, 2));
  const mm  = dateStr.slice(2, 4);
  const dd  = dateStr.slice(4, 6);
  const year = 2000 + yy;
  const expiration = `${year}-${mm}-${dd}`;
  const strike = parseInt(strikeStr) / 1000;

  return { underlying: under, expiration, isCall: type.toUpperCase() === 'C', strike };
}

function calcDte(expiration: string): number {
  const exp = new Date(expiration + 'T16:00:00');
  const now = new Date();
  return Math.max(0, Math.ceil((exp.getTime() - now.getTime()) / 86_400_000));
}

function fmtDate(d: string) {
  return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
}

function fmt$(n: number) {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function parsePositionToPut(pos: EnrichedPosition): ParsedPut | null {
  if (pos.instrument?.assetType !== 'OPTION') return null;
  if (!(pos.shortQuantity > 0)) return null;  // Vol 6 tracker = short puts only

  const rawSymbol = pos.instrument?.symbol ?? '';
  const parsed    = parseOCC(rawSymbol);
  if (!parsed || parsed.isCall) return null;  // puts only

  const absQty = pos.shortQuantity || 1;

  // avgCost = credit received per share when sold; ×100 for per-contract dollar value
  const avgCost         = pos.averagePrice ?? 0;
  const premiumReceived = avgCost * absQty * 100;

  // Schwab returns marketValue as negative for short positions (liability).
  // Math.abs() normalises it to cost-to-close regardless of sign convention.
  const currentValue   = Math.abs(pos.marketValue ?? 0);
  const currentPremium = currentValue / absQty;

  // Profit = premium collected minus current cost to close
  const profitDollars = premiumReceived - currentValue;
  const profitPct     = premiumReceived > 0 ? (profitDollars / premiumReceived) * 100 : 0;

  // Close target: when cost-to-close drops to 25% of original (= 75% profit captured)
  const closeTarget75 = premiumReceived * 0.25;

  const dte = calcDte(parsed.expiration);

  let status: ParsedPut['status'] = 'neutral';
  if (profitPct >= 75)                          status = 'close_now';
  else if (profitPct >= 40)                     status = 'profitable';
  else if (profitPct < 0)                       status = 'losing';
  // DTE < 21: roll if still profitable (25-74%), expiry_warning if losing/neutral
  if (dte < 21 && status !== 'close_now') {
    status = (profitPct >= 25) ? 'roll' : 'expiry_warning';
  }

  return {
    symbol:          rawSymbol,
    underlying:      parsed.underlying,
    expiration:      parsed.expiration,
    dte,
    strike:          parsed.strike,
    quantity:        absQty,
    avgCost,
    currentValue,
    premiumReceived,
    currentPremium,
    profitPct,
    closeTarget75,
    status,
  };
}

const STATUS_CONFIG = {
  close_now:      { label: 'Close Now ✓',    color: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30', icon: <CheckCircle className="w-3.5 h-3.5 text-emerald-400" /> },
  roll:           { label: 'Roll Now →',     color: 'bg-violet-500/20 text-violet-300 border-violet-500/30',   icon: <AlertTriangle className="w-3.5 h-3.5 text-violet-400" /> },
  profitable:     { label: 'Profitable',      color: 'bg-blue-500/20 text-blue-300 border-blue-500/30',         icon: <TrendingDown className="w-3.5 h-3.5 text-blue-400" /> },
  neutral:        { label: 'Watching',        color: 'bg-[#2d3248] text-[#7c82a0] border-[#3d4260]',            icon: <Clock className="w-3.5 h-3.5 text-[#7c82a0]" /> },
  losing:         { label: 'Underwater',      color: 'bg-red-500/20 text-red-300 border-red-500/30',             icon: <AlertTriangle className="w-3.5 h-3.5 text-red-400" /> },
  expiry_warning: { label: 'Expiry <21d',     color: 'bg-orange-500/20 text-orange-300 border-orange-500/30',   icon: <AlertTriangle className="w-3.5 h-3.5 text-orange-400" /> },
};

export function OpenPutTracker({ positions }: Props) {
  const [open, setOpen] = useState(false);
  // Track in-flight action per OCC symbol so only that row's button spinner.
  const [pending, setPending] = useState<{ symbol: string; action: 'close' | 'roll' } | null>(null);
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const puts: ParsedPut[] = positions
    .map(parsePositionToPut)
    .filter((p): p is ParsedPut => p !== null)
    .sort((a, b) => {
      // Close-now first, then expiry warnings, then by DTE
      const priority = { close_now: 0, roll: 1, expiry_warning: 2, losing: 3, profitable: 4, neutral: 5 };
      if (priority[a.status] !== priority[b.status]) return priority[a.status] - priority[b.status];
      return a.dte - b.dte;
    });

  /**
   * Stage a BUY_TO_CLOSE for an open short put. Limit price = current
   * cost-to-close per share (Schwab will fill at or better). User can
   * adjust the limit in the inbox before approving.
   */
  async function handleClose(p: ParsedPut) {
    if (pending) return;
    setPending({ symbol: p.symbol, action: 'close' });
    setFeedback(null);
    try {
      const limitPerShare = +(p.currentPremium / 100).toFixed(2);
      const r = await fetch('/api/inbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [{
            source:      'option',
            symbol:      p.underlying,
            instruction: 'BUY_TO_CLOSE',
            quantity:    p.quantity,
            orderType:   'LIMIT',
            occSymbol:   p.symbol,
            limitPrice:  Math.max(limitPerShare, 0.01),
            price:       Math.max(limitPerShare, 0.01),
            rationale:   `Vol 6 close: ${p.profitPct.toFixed(0)}% profit captured on ${p.underlying} $${p.strike}P (${p.dte}d remaining). Limit = current ask.`,
            aiMode:      'put_close',
            violations:  [],
          }],
        }),
      });
      const d = await r.json();
      if (!r.ok || d.rejected > 0) throw new Error(d.error ?? d.rejectedReason ?? `HTTP ${r.status}`);
      setFeedback({ kind: 'ok', text: `Staged BUY_TO_CLOSE ${p.underlying} $${p.strike}P to Trade Inbox.` });
    } catch (err) {
      setFeedback({ kind: 'err', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setPending(null);
    }
  }

  /**
   * Roll: stage a BUY_TO_CLOSE for the current contract AND ask
   * /api/option-plan to pick + auto-stage a fresh 60–90 DTE / 0.25 delta
   * SELL_TO_OPEN on the same underlying. Both items end up in the inbox;
   * user reviews + approves each leg independently.
   */
  async function handleRoll(p: ParsedPut) {
    if (pending) return;
    setPending({ symbol: p.symbol, action: 'roll' });
    setFeedback(null);
    try {
      // Leg 1: close current contract.
      const limitPerShare = +(p.currentPremium / 100).toFixed(2);
      const closeRes = await fetch('/api/inbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [{
            source:      'option',
            symbol:      p.underlying,
            instruction: 'BUY_TO_CLOSE',
            quantity:    p.quantity,
            orderType:   'LIMIT',
            occSymbol:   p.symbol,
            limitPrice:  Math.max(limitPerShare, 0.01),
            price:       Math.max(limitPerShare, 0.01),
            rationale:   `Vol 6 roll (close leg): ${p.profitPct.toFixed(0)}% captured on ${p.underlying} $${p.strike}P, ${p.dte}d to expiry. Pairs with new SELL_TO_OPEN.`,
            aiMode:      'put_roll',
            violations:  [],
          }],
        }),
      });
      const closeData = await closeRes.json();
      if (!closeRes.ok || closeData.rejected > 0) throw new Error(closeData.error ?? closeData.rejectedReason ?? `Close leg: HTTP ${closeRes.status}`);

      // Leg 2: option-plan picks the new contract and auto-stages it.
      const plan = await fetchOptionPlan({
        symbol:    p.underlying,
        mode:      'sell_put',
        contracts: p.quantity,
      });

      setFeedback({
        kind: 'ok',
        text: `Roll staged: close ${p.underlying} $${p.strike}P + new SELL_TO_OPEN $${plan.selectedContract.strike}P ${plan.selectedContract.dte}d (${plan.selectedContract.delta.toFixed(2)} Δ).`,
      });
    } catch (err) {
      setFeedback({ kind: 'err', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setPending(null);
    }
  }

  const totalReceived  = puts.reduce((s, p) => s + p.premiumReceived, 0);
  const totalCurrent   = puts.reduce((s, p) => s + p.currentValue, 0);
  const totalProfit    = totalReceived - totalCurrent;
  const closeNowCount  = puts.filter((p) => p.status === 'close_now').length;

  return (
    <div className="bg-[#1a1d27] border border-[#2d3248] rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-5 py-4 hover:bg-[#20243a] transition-colors"
      >
        <div className="flex items-center gap-2.5">
          <TrendingDown className="w-5 h-5 text-blue-400" />
          <span className="font-semibold text-white text-sm">Open Put Positions</span>
          {puts.length > 0 && (
            <span className="text-xs text-[#4a5070] bg-[#2d3248] px-2 py-0.5 rounded-full">
              {puts.length} contract{puts.length !== 1 ? 's' : ''}
              {closeNowCount > 0 && <span className="ml-1 text-emerald-400">· {closeNowCount} to close</span>}
            </span>
          )}
        </div>
        {open ? <ChevronUp className="w-4 h-4 text-[#7c82a0]" /> : <ChevronDown className="w-4 h-4 text-[#7c82a0]" />}
      </button>

      {open && (
        <div className="border-t border-[#2d3248] px-5 py-4 space-y-4">
          {puts.length === 0 ? (
            <div className="text-center py-8 space-y-2">
              <TrendingDown className="w-8 h-8 text-[#2d3248] mx-auto" />
              <p className="text-sm text-[#4a5070]">No open put positions found.</p>
              <p className="text-xs text-[#3d4260]">Use the AI Trade Plan to find Vol 6 put-selling opportunities.</p>
            </div>
          ) : (
            <>
              {/* Summary stats */}
              <div className="grid grid-cols-3 gap-3">
                <div className="bg-[#0f1117] border border-[#2d3248] rounded-lg p-3">
                  <div className="text-[10px] text-[#7c82a0] mb-1">Premium Received</div>
                  <div className="text-sm font-bold text-white">{fmt$(totalReceived)}</div>
                </div>
                <div className="bg-[#0f1117] border border-[#2d3248] rounded-lg p-3">
                  <div className="text-[10px] text-[#7c82a0] mb-1">Cost to Close</div>
                  <div className="text-sm font-bold text-white">{fmt$(totalCurrent)}</div>
                </div>
                <div className="bg-[#0f1117] border border-[#2d3248] rounded-lg p-3">
                  <div className="text-[10px] text-[#7c82a0] mb-1">Profit Kept</div>
                  <div className={`text-sm font-bold ${totalProfit >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {fmt$(totalProfit)}
                  </div>
                </div>
              </div>

              {/* Vol 6 reminder */}
              <div className="text-[10px] text-[#4a5070] bg-[#0f1117] border border-[#2d3248] rounded px-3 py-2">
                Vol 6 rules: Close at 75% profit · Roll at DTE &lt;21 with 25–74% profit (buy-to-close + sell new 60–90 DTE) · Sell on down days
              </div>

              {feedback && (
                <div className={`text-[11px] rounded px-3 py-1.5 border ${
                  feedback.kind === 'ok'
                    ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-300'
                    : 'bg-red-500/10 border-red-500/40 text-red-300'
                }`}>
                  {feedback.text}
                </div>
              )}

              {/* Position table */}
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-[#2d3248] text-[#4a5070]">
                      <th className="text-left px-2 py-2 font-medium">Underlying</th>
                      <th className="text-right px-2 py-2 font-medium">Strike</th>
                      <th className="text-right px-2 py-2 font-medium">Expiry</th>
                      <th className="text-right px-2 py-2 font-medium">DTE</th>
                      <th className="text-right px-2 py-2 font-medium">Qty</th>
                      <th className="text-right px-2 py-2 font-medium">Received</th>
                      <th className="text-right px-2 py-2 font-medium">Close@75%</th>
                      <th className="text-right px-2 py-2 font-medium">Current</th>
                      <th className="text-right px-2 py-2 font-medium">P&L%</th>
                      <th className="text-right px-2 py-2 font-medium">Status</th>
                      <th className="text-right px-2 py-2 font-medium">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {puts.map((p) => {
                      const cfg = STATUS_CONFIG[p.status];
                      const busy = pending?.symbol === p.symbol;
                      const closeFeatured = p.status === 'close_now';
                      const rollFeatured  = p.status === 'roll' || p.status === 'expiry_warning';
                      return (
                        <tr key={p.symbol} className={`border-b border-[#1a1d27] ${
                          p.status === 'close_now' ? 'bg-emerald-500/5' :
                          p.status === 'expiry_warning' ? 'bg-orange-500/5' :
                          p.status === 'losing' ? 'bg-red-500/5' : 'hover:bg-[#0f1117]'
                        }`}>
                          <td className="px-2 py-2.5 font-mono font-semibold text-white">{p.underlying}</td>
                          <td className="text-right px-2 py-2.5 font-mono text-white">${p.strike.toFixed(0)}</td>
                          <td className="text-right px-2 py-2.5 text-[#7c82a0]">{fmtDate(p.expiration)}</td>
                          <td className={`text-right px-2 py-2.5 font-mono ${
                            p.dte < 14 ? 'text-red-400' : p.dte < 21 ? 'text-orange-400' : 'text-[#7c82a0]'
                          }`}>{p.dte}d</td>
                          <td className="text-right px-2 py-2.5 text-[#7c82a0]">{p.quantity}</td>
                          <td className="text-right px-2 py-2.5 font-mono text-[#7c82a0]">{fmt$(p.premiumReceived)}</td>
                          <td className="text-right px-2 py-2.5 font-mono text-orange-400">{fmt$(p.closeTarget75)}</td>
                          <td className="text-right px-2 py-2.5 font-mono text-white">{fmt$(p.currentValue)}</td>
                          <td className={`text-right px-2 py-2.5 font-mono font-semibold ${
                            p.profitPct >= 75 ? 'text-emerald-400' :
                            p.profitPct >= 40 ? 'text-blue-400' :
                            p.profitPct < 0   ? 'text-red-400' : 'text-[#7c82a0]'
                          }`}>{p.profitPct.toFixed(0)}%</td>
                          <td className="text-right px-2 py-2.5">
                            <span className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border ${cfg.color}`}>
                              {cfg.icon}
                              {cfg.label}
                            </span>
                          </td>
                          <td className="text-right px-2 py-2.5">
                            <div className="inline-flex gap-1">
                              <button
                                onClick={() => handleClose(p)}
                                disabled={busy || pending !== null}
                                title="Stage BUY_TO_CLOSE to Trade Inbox at current ask"
                                className={`text-[10px] px-2 py-0.5 rounded border transition-colors flex items-center gap-1 disabled:opacity-50 ${
                                  closeFeatured
                                    ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/30'
                                    : 'bg-[#1a1d27] border-[#2d3248] text-[#7c82a0] hover:text-white hover:bg-[#252840]'
                                }`}
                              >
                                {busy && pending?.action === 'close' ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />}
                                Close
                              </button>
                              <button
                                onClick={() => handleRoll(p)}
                                disabled={busy || pending !== null}
                                title="Stage BUY_TO_CLOSE + AI-pick a fresh 60–90 DTE SELL_TO_OPEN"
                                className={`text-[10px] px-2 py-0.5 rounded border transition-colors flex items-center gap-1 disabled:opacity-50 ${
                                  rollFeatured
                                    ? 'bg-violet-500/20 border-violet-500/40 text-violet-300 hover:bg-violet-500/30'
                                    : 'bg-[#1a1d27] border-[#2d3248] text-[#7c82a0] hover:text-white hover:bg-[#252840]'
                                }`}
                              >
                                {busy && pending?.action === 'roll' ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCw className="w-3 h-3" />}
                                Roll
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

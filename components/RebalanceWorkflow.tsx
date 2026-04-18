'use client';

/**
 * RebalanceWorkflow — AI-powered rebalance with direct order submission.
 *
 * Flow:
 *   1. Drift summary — shows each pillar's current vs target with $ drift
 *   2. Get AI Plan  — calls /api/rebalance-plan for specific share orders
 *   3. Review       — edit shares, remove orders
 *   4. Place Orders — submits to /api/orders → shows per-order results
 *
 * Rules enforced:
 *   - Vol 7 1/3 rule: income trim → 1/3 goes to Triples
 *   - Never sell Cornerstone (CLM/CRF)
 *   - Shares = Math.floor(dollars/price), never fractional
 *   - Only submits orders the user has reviewed
 */

import { useState } from 'react';
import {
  Sparkles, Loader2, TrendingUp, TrendingDown, Minus,
  ShoppingCart, X, AlertTriangle, CheckCircle, RefreshCw,
  ChevronDown, ChevronUp,
} from 'lucide-react';
import type { EnrichedPosition, PillarType } from '@/lib/schwab/types';
import type { PillarSummary } from '@/lib/classify';
import type { StrategyTargets } from '@/lib/utils';
import type { RebalanceOrder } from '@/app/api/rebalance-plan/route';

// ─── Types ────────────────────────────────────────────────────────────────────

interface PillarDrift {
  pillar:       string;
  label:        string;
  currentPct:   number;
  targetPct:    number;
  driftPct:     number;
  driftDollars: number;
  action:       'buy' | 'sell' | 'hold';
}

interface EditableOrder extends RebalanceOrder {
  id:     string;
  result: string | null;  // order placement result
}

interface PlanResponse {
  orders:  RebalanceOrder[];
  summary: string;
  drifts:  PillarDrift[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const PILLAR_COLOR: Record<string, string> = {
  triples:     'text-violet-400',
  cornerstone: 'text-amber-400',
  income:      'text-emerald-400',
  hedge:       'text-blue-400',
};

const PILLAR_BAR: Record<string, string> = {
  triples:     'bg-violet-500',
  cornerstone: 'bg-amber-500',
  income:      'bg-emerald-500',
  hedge:       'bg-blue-500',
};

function fmt$(n: number) {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

// ─── Drift bar row ────────────────────────────────────────────────────────────

function DriftRow({ d }: { d: PillarDrift }) {
  const over  = d.driftPct > 1;
  const under = d.driftPct < -1;
  const barColor = PILLAR_BAR[d.pillar] ?? 'bg-[#4a5070]';
  const labelColor = PILLAR_COLOR[d.pillar] ?? 'text-white';

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 text-xs">
        <span className={`w-24 font-semibold capitalize ${labelColor}`}>
          {d.pillar === 'triples' ? 'Triples' :
           d.pillar === 'cornerstone' ? 'Cornerstone' :
           d.pillar === 'income' ? 'Core / Income' : 'Hedge'}
        </span>
        <div className="flex-1 relative h-2 bg-[#2d3248] rounded-full overflow-visible">
          <div
            className={`h-full rounded-full transition-all ${barColor}`}
            style={{ width: `${Math.min(d.currentPct, 100)}%` }}
          />
          {/* Target marker */}
          <div
            className="absolute top-0 h-full w-0.5 bg-white/50"
            style={{ left: `${Math.min(d.targetPct, 100)}%` }}
          />
        </div>
        <span className="w-12 text-right text-[#e8eaf0] font-mono tabular-nums">
          {d.currentPct.toFixed(1)}%
        </span>
        <span className="text-[#4a5070]">→</span>
        <span className="w-8 text-[#7c82a0] font-mono tabular-nums">
          {d.targetPct}%
        </span>
        <span className={`w-20 text-right font-mono font-semibold tabular-nums ${
          over ? 'text-orange-400' : under ? 'text-blue-400' : 'text-emerald-400'
        }`}>
          {over  ? `−${fmt$(Math.abs(d.driftDollars))}` :
           under ? `+${fmt$(Math.abs(d.driftDollars))}` :
           '✓ ok'}
        </span>
      </div>
    </div>
  );
}

// ─── Order row ────────────────────────────────────────────────────────────────

function OrderRow({
  order,
  onSharesChange,
  onRemove,
}: {
  order: EditableOrder;
  onSharesChange: (id: string, n: number) => void;
  onRemove: (id: string) => void;
}) {
  const isSell = order.instruction === 'SELL';
  const pillarColor = PILLAR_COLOR[order.pillar] ?? 'text-[#7c82a0]';
  const estValue = order.shares * order.currentPrice;

  return (
    <div className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs ${
      order.result
        ? order.result.startsWith('✓')
          ? 'bg-emerald-500/10 border-emerald-500/20'
          : 'bg-red-500/10 border-red-500/20'
        : isSell
          ? 'bg-orange-500/8 border-orange-500/20'
          : 'bg-blue-500/8 border-blue-500/20'
    }`}>
      {/* Instruction badge */}
      <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold shrink-0 ${
        isSell ? 'bg-orange-600/30 text-orange-200' : 'bg-blue-600/30 text-blue-200'
      }`}>
        {order.instruction}
      </span>

      {/* Symbol */}
      <span className="font-mono font-semibold text-white w-16 shrink-0">{order.symbol}</span>

      {/* Pillar */}
      <span className={`hidden sm:inline text-[10px] capitalize shrink-0 ${pillarColor}`}>
        {order.pillar}
      </span>

      {/* Shares adjuster */}
      <div className="flex items-center gap-1 ml-auto">
        <button
          onClick={() => onSharesChange(order.id, Math.max(1, order.shares - 1))}
          disabled={!!order.result}
          className="w-5 h-5 rounded bg-[#2d3248] text-white hover:bg-[#3d4268] flex items-center justify-center text-sm leading-none disabled:opacity-30"
        >−</button>
        <span className="w-8 text-center font-mono text-white">{order.shares}</span>
        <button
          onClick={() => onSharesChange(order.id, order.shares + 1)}
          disabled={!!order.result}
          className="w-5 h-5 rounded bg-[#2d3248] text-white hover:bg-[#3d4268] flex items-center justify-center text-sm leading-none disabled:opacity-30"
        >+</button>
      </div>

      {/* @ price */}
      <span className="text-[#4a5070] shrink-0">@ ${order.currentPrice.toFixed(2)}</span>

      {/* Est value */}
      <span className={`font-mono font-semibold w-20 text-right shrink-0 ${
        isSell ? 'text-orange-300' : 'text-blue-300'
      }`}>
        {fmt$(estValue)}
      </span>

      {/* Result or remove */}
      {order.result ? (
        <span className={`text-[10px] shrink-0 ${
          order.result.startsWith('✓') ? 'text-emerald-400' : 'text-red-400'
        }`}>
          {order.result.startsWith('✓') ? '✓ placed' : '✗ failed'}
        </span>
      ) : (
        <button
          onClick={() => onRemove(order.id)}
          className="text-[#4a5070] hover:text-red-400 shrink-0"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

interface Props {
  positions:       EnrichedPosition[];
  pillarSummary:   PillarSummary[];
  totalValue:      number;
  equity:          number;
  marginBalance:   number;
  accountHash:     string;
  strategyTargets: StrategyTargets;
}

export function RebalanceWorkflow({
  positions,
  pillarSummary,
  totalValue,
  equity,
  marginBalance,
  accountHash,
  strategyTargets,
}: Props) {
  const [loadingPlan, setLoadingPlan] = useState(false);
  const [planError,   setPlanError]   = useState<string | null>(null);
  const [drifts,      setDrifts]      = useState<PillarDrift[]>([]);
  const [orders,      setOrders]      = useState<EditableOrder[]>([]);
  const [summary,     setSummary]     = useState('');
  const [placing,     setPlacing]     = useState(false);
  const [allPlaced,   setAllPlaced]   = useState(false);
  const [showDrift,   setShowDrift]   = useState(true);

  const targets = {
    triplesPct:     strategyTargets.triplesPct,
    cornerstonePct: strategyTargets.cornerstonePct,
    incomePct:      strategyTargets.incomePct,
    hedgePct:       strategyTargets.hedgePct,
  };

  // ── Get AI plan ─────────────────────────────────────────────────────────────

  const getPlan = async () => {
    setLoadingPlan(true);
    setPlanError(null);
    setOrders([]);
    setSummary('');
    setAllPlaced(false);

    try {
      const res = await fetch('/api/rebalance-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ totalValue, equity, positions, pillarSummary, targets }),
      });
      const data: PlanResponse = await res.json();
      if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);

      setDrifts(data.drifts ?? []);
      setSummary(data.summary ?? '');
      setOrders(
        (data.orders ?? []).map((o, i) => ({ ...o, id: `order-${i}-${o.symbol}`, result: null }))
      );
    } catch (e) {
      setPlanError(e instanceof Error ? e.message : 'AI plan failed');
    } finally {
      setLoadingPlan(false);
    }
  };

  // ── Edit orders ──────────────────────────────────────────────────────────────

  const updateShares = (id: string, n: number) => {
    setOrders((prev) => prev.map((o) =>
      o.id === id ? { ...o, shares: Math.max(1, n), estimatedValue: Math.max(1, n) * o.currentPrice } : o
    ));
  };

  const removeOrder = (id: string) => {
    setOrders((prev) => prev.filter((o) => o.id !== id));
  };

  // ── Place orders ─────────────────────────────────────────────────────────────

  const placeOrders = async () => {
    const pending = orders.filter((o) => !o.result);
    if (!pending.length || !accountHash) return;
    setPlacing(true);

    try {
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountHash,
          orders: pending.map((o) => ({
            symbol:      o.symbol,
            instruction: o.instruction,
            quantity:    o.shares,
            orderType:   'MARKET',
            rationale:   o.rationale,
            aiMode:      'rebalance',
          })),
        }),
      });
      const data = await res.json();
      const results = data.equityResults ?? data.results ?? [];

      setOrders((prev) =>
        prev.map((o) => {
          if (o.result) return o;
          const idx    = pending.findIndex((p) => p.id === o.id);
          const r      = results[idx];
          const result = r?.status === 'placed'
            ? `✓ ID ${r.orderId ?? 'ok'}`
            : `✗ ${r?.message ?? 'error'}`;
          return { ...o, result };
        })
      );
      setAllPlaced(true);
    } catch (e) {
      setPlanError(e instanceof Error ? e.message : 'Order submission failed');
    } finally {
      setPlacing(false);
    }
  };

  // ── Derived state ────────────────────────────────────────────────────────────

  const hasPlan      = orders.length > 0 || summary;
  const pendingCount = orders.filter((o) => !o.result).length;
  const placedCount  = orders.filter((o) => o.result?.startsWith('✓')).length;
  const failedCount  = orders.filter((o) => o.result && !o.result.startsWith('✓')).length;

  const totalSell = orders
    .filter((o) => o.instruction === 'SELL')
    .reduce((s, o) => s + o.shares * o.currentPrice, 0);
  const totalBuy = orders
    .filter((o) => o.instruction === 'BUY')
    .reduce((s, o) => s + o.shares * o.currentPrice, 0);

  // Build simple drift data from pillarSummary if AI hasn't returned drifts yet
  const displayDrifts: PillarDrift[] = drifts.length > 0 ? drifts :
    ['triples', 'cornerstone', 'income', 'hedge'].map((pillar) => {
      const ps     = pillarSummary.find((p) => p.pillar === pillar);
      const target = targets[`${pillar}Pct` as keyof typeof targets] ?? 0;
      const curr   = ps?.portfolioPercent ?? 0;
      const drift  = curr - target;
      return {
        pillar,
        label:        ps?.label ?? pillar,
        currentPct:   curr,
        targetPct:    target,
        driftPct:     drift,
        driftDollars: (drift / 100) * totalValue,
        action:       Math.abs(drift) < 1 ? 'hold' : drift > 0 ? 'sell' : 'buy',
      };
    });

  const significantDrifts = displayDrifts.filter((d) => Math.abs(d.driftPct) >= 1);

  return (
    <div className="bg-[#1a1d27] border border-[#2d3248] rounded-xl overflow-hidden">

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-5 py-4">
        <div className="flex items-center gap-2.5">
          <Sparkles className="w-4 h-4 text-violet-400" />
          <span className="font-semibold text-white text-sm">Rebalance Workflow</span>
          <span className="text-[10px] bg-violet-500/15 text-violet-400 px-2 py-0.5 rounded-full border border-violet-500/25">
            AI + live orders
          </span>
        </div>
        <div className="flex items-center gap-2">
          {significantDrifts.length > 0 && !hasPlan && (
            <span className="text-[10px] text-orange-400">
              {significantDrifts.length} pillar{significantDrifts.length > 1 ? 's' : ''} off-target
            </span>
          )}
          <button
            onClick={() => setShowDrift((v) => !v)}
            className="text-[#4a5070] hover:text-white"
          >
            {showDrift ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {showDrift && (
        <div className="border-t border-[#2d3248] px-5 py-4 space-y-5">

          {/* ── Drift summary ────────────────────────────────────────────────── */}
          <div className="space-y-2">
            <div className="flex items-center justify-between mb-1">
              <p className="text-[11px] font-semibold text-[#7c82a0] uppercase tracking-wide">
                Pillar Allocation vs Targets
              </p>
              <p className="text-[10px] text-[#4a5070]">white line = target</p>
            </div>
            {displayDrifts.map((d) => <DriftRow key={d.pillar} d={d} />)}
          </div>

          {/* ── Get AI plan button ───────────────────────────────────────────── */}
          <div className="flex items-center gap-3">
            <button
              onClick={getPlan}
              disabled={loadingPlan}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white transition-colors"
            >
              {loadingPlan ? (
                <><Loader2 className="w-4 h-4 animate-spin" />Analysing portfolio…</>
              ) : hasPlan ? (
                <><RefreshCw className="w-4 h-4" />Refresh Plan</>
              ) : (
                <><Sparkles className="w-4 h-4" />Get AI Rebalance Plan</>
              )}
            </button>
            {significantDrifts.length === 0 && (
              <span className="text-xs text-emerald-400 flex items-center gap-1">
                <CheckCircle className="w-3.5 h-3.5" /> Portfolio is within 1% of all targets
              </span>
            )}
          </div>

          {/* ── Error ────────────────────────────────────────────────────────── */}
          {planError && (
            <div className="flex items-center gap-2 px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-300">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              {planError}
            </div>
          )}

          {/* ── AI Plan ──────────────────────────────────────────────────────── */}
          {hasPlan && !loadingPlan && (
            <div className="space-y-3">

              {/* Summary */}
              {summary && (
                <div className="flex items-start gap-2 px-3 py-2 bg-violet-500/8 border border-violet-500/20 rounded-lg text-xs text-violet-200">
                  <Sparkles className="w-3.5 h-3.5 shrink-0 mt-0.5 text-violet-400" />
                  {summary}
                </div>
              )}

              {orders.length === 0 ? (
                <div className="flex items-center gap-2 px-3 py-2 bg-emerald-500/10 border border-emerald-500/20 rounded-lg text-xs text-emerald-300">
                  <CheckCircle className="w-3.5 h-3.5" />
                  No orders needed — all pillars are within target range.
                </div>
              ) : (
                <>
                  {/* Order list header */}
                  <div className="flex items-center justify-between">
                    <p className="text-[11px] font-semibold text-[#7c82a0] uppercase tracking-wide">
                      Orders ({orders.length})
                    </p>
                    <div className="flex items-center gap-3 text-[10px] text-[#4a5070]">
                      {totalSell > 0 && <span className="text-orange-300">Sell ≈ {fmt$(totalSell)}</span>}
                      {totalBuy  > 0 && <span className="text-blue-300">Buy ≈ {fmt$(totalBuy)}</span>}
                    </div>
                  </div>

                  {/* Orders */}
                  <div className="space-y-1.5">
                    {orders.map((o) => (
                      <OrderRow
                        key={o.id}
                        order={o}
                        onSharesChange={updateShares}
                        onRemove={removeOrder}
                      />
                    ))}
                  </div>

                  {/* Rationale accordion */}
                  <details className="text-[10px] text-[#4a5070] cursor-pointer">
                    <summary className="hover:text-[#7c82a0]">Show order rationale</summary>
                    <div className="mt-1 space-y-1 pl-2 border-l border-[#2d3248]">
                      {orders.map((o) => (
                        <p key={o.id}>
                          <span className="font-mono text-white">{o.symbol}</span>: {o.rationale}
                        </p>
                      ))}
                    </div>
                  </details>

                  {/* Place orders */}
                  {!allPlaced ? (
                    <div className="flex items-center gap-3 pt-1">
                      <button
                        onClick={placeOrders}
                        disabled={placing || pendingCount === 0}
                        className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white transition-colors"
                      >
                        {placing ? (
                          <><Loader2 className="w-4 h-4 animate-spin" />Placing…</>
                        ) : (
                          <><ShoppingCart className="w-4 h-4" />Place {pendingCount} Market Order{pendingCount !== 1 ? 's' : ''}</>
                        )}
                      </button>
                      <p className="text-[10px] text-[#4a5070]">
                        Market orders execute at current price — review shares before submitting.
                      </p>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs border
                      bg-emerald-500/10 border-emerald-500/20 text-emerald-300">
                      <CheckCircle className="w-3.5 h-3.5 shrink-0" />
                      {placedCount} order{placedCount !== 1 ? 's' : ''} placed
                      {failedCount > 0 && ` · ${failedCount} failed`}
                      {' · '}
                      <button onClick={getPlan} className="underline hover:no-underline">
                        get updated plan
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* ── Footer note ──────────────────────────────────────────────────── */}
          <p className="text-[10px] text-[#4a5070]">
            Vol 7 1/3 rule: when trimming income, 1/3 of freed capital routes to Triples.
            Cornerstone (CLM/CRF) is never sold — long-term DRIP positions only.
            Orders are MARKET type; verify prices are acceptable before placing.
          </p>
        </div>
      )}
    </div>
  );
}

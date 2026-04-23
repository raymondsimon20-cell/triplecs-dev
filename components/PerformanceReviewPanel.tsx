'use client';

/**
 * PerformanceReviewPanel — Phase 3 surface.
 *
 * Two halves:
 *   1. Read-only recap (30d operational, 90d strategic): hit rate +
 *      expectancy by aiMode, regime context.
 *   2. AI-driven review: button calls /api/performance-review POST →
 *      Claude proposes target adjustments → user reviews diff and clicks
 *      "Apply to Settings" to commit (uses existing updateStrategyTargets).
 */

import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Brain, RefreshCw, AlertTriangle, CheckCircle2, TrendingUp, TrendingDown,
  Sparkles, Activity, ArrowRight, Loader2,
} from 'lucide-react';
import { updateStrategyTargets } from './SettingsPanel';
import type { StrategyTargets } from '@/lib/utils';

interface ModeSummary {
  aiMode: string;
  count: number;
  wins: number;
  losses: number;
  flat: number;
  hitRatePct: number;
  avgWinPct: number;
  avgLossPct: number;
  expectancyPct: number;
  totalPnlDollars: number;
}

interface RegimeContext {
  windowDays: number;
  spyReturnPct: number | null;
  drawdownPct: number;
  startDate: string;
  endDate: string;
}

interface FullRecap {
  windowDays: number;
  byMode: ModeSummary[];
  regime: RegimeContext;
  totals: {
    executedCount: number;
    dismissedCount: number;
    totalPnlDollars: number;
    overallHitRatePct: number;
    overallExpectancyPct: number;
  };
}

interface RecapPayload {
  recap30: FullRecap | null;
  recap90: FullRecap | null;
}

interface ReviewResponse {
  recap?: FullRecap;
  proposed: Partial<StrategyTargets>;
  rationale: string;
  keyFindings: string[];
  paused?: boolean;
  error?: string;
}

interface Props {
  currentTargets: StrategyTargets;
}

function fmtPct(n: number, dp = 1): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(dp)}%`;
}
function fmtUSD(n: number): string {
  const sign = n >= 0 ? '+' : '−';
  return `${sign}$${Math.abs(Math.round(n)).toLocaleString()}`;
}

const MODE_LABELS: Record<string, string> = {
  rebalance_plan: 'Rebalance',
  sell_put:       'Sell Puts',
  buy_put:        'Buy Puts',
  daily_pulse:    'Daily Pulse',
  what_to_sell:   'What to Sell',
  open_question:  'Open Q&A',
  unknown:        'Unknown',
};

export function PerformanceReviewPanel({ currentTargets }: Props) {
  const [data, setData]         = useState<RecapPayload | null>(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [review, setReview]     = useState<ReviewResponse | null>(null);
  const [windowMode, setWindowMode] = useState<'30d' | '90d'>('30d');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/performance-review');
      const d: RecapPayload | { error: string } = await r.json();
      if ('error' in d) setError(d.error);
      else { setData(d); setError(null); }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function runReview() {
    setReviewing(true);
    setReview(null);
    try {
      const r = await fetch('/api/performance-review', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ currentTargets }),
      });
      const d: ReviewResponse = await r.json();
      if (d.error && !d.paused) {
        setError(d.error);
      } else {
        setReview(d);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReviewing(false);
    }
  }

  function applyProposed() {
    if (!review?.proposed) return;
    const merged: StrategyTargets = { ...currentTargets, ...review.proposed };
    if (!confirm('Apply these proposed targets to Settings? You can always adjust manually after.')) return;
    updateStrategyTargets(merged);
    setReview(null);
  }

  if (loading) {
    return (
      <div className="h-32 flex items-center justify-center">
        <div className="w-5 h-5 border-2 border-purple-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-xs text-red-400 flex items-center gap-2">
        <AlertTriangle className="w-4 h-4" /> {error}
      </div>
    );
  }

  const recap = windowMode === '30d' ? data?.recap30 : data?.recap90;

  if (!recap || recap.totals.executedCount + recap.totals.dismissedCount === 0) {
    return (
      <div className="text-xs text-[#7c82a0] flex items-start gap-2">
        <Activity className="w-4 h-4 mt-0.5 flex-shrink-0" />
        <div>
          No recommendations in window yet. Run a Rebalance Plan or Options Plan to start
          accumulating outcomes — the AI feedback loop kicks in once you have a few decided recs.
        </div>
      </div>
    );
  }

  const proposedKeys = review ? Object.keys(review.proposed ?? {}) as Array<keyof StrategyTargets> : [];
  const hasProposal = proposedKeys.length > 0;

  return (
    <div className="space-y-5">
      {/* ── Header: window switch + AI button ─────────────────────────────── */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-1 text-xs">
          {(['30d', '90d'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setWindowMode(m)}
              className={[
                'px-2.5 py-1 rounded transition-colors',
                windowMode === m
                  ? 'bg-purple-500/20 text-purple-300 border border-purple-500/40'
                  : 'text-[#7c82a0] border border-transparent hover:text-white hover:bg-white/[0.04]',
              ].join(' ')}
            >
              {m}
            </button>
          ))}
          <button
            onClick={load}
            className="px-2 py-1 rounded text-[#7c82a0] hover:text-white hover:bg-white/[0.04] transition-colors flex items-center gap-1 text-[10px] ml-1"
          >
            <RefreshCw className="w-3 h-3" /> Refresh
          </button>
        </div>

        <button
          onClick={runReview}
          disabled={reviewing}
          className="text-[11px] px-3 py-1.5 rounded bg-purple-500/15 border border-purple-500/40 text-purple-300 hover:bg-purple-500/25 disabled:opacity-50 transition-colors flex items-center gap-1.5 font-semibold"
        >
          {reviewing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Brain className="w-3.5 h-3.5" />}
          {reviewing ? 'Reviewing 90d…' : 'AI Review (90d)'}
        </button>
      </div>

      {/* ── Top-line metrics ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
        <Metric label="Hit rate" value={`${recap.totals.overallHitRatePct.toFixed(0)}%`} positive={recap.totals.overallHitRatePct >= 50} />
        <Metric label="Expectancy" value={fmtPct(recap.totals.overallExpectancyPct, 2)} positive={recap.totals.overallExpectancyPct >= 0} />
        <Metric label="P&L" value={fmtUSD(recap.totals.totalPnlDollars)} positive={recap.totals.totalPnlDollars >= 0} />
        <Metric
          label="SPY (window)"
          value={recap.regime.spyReturnPct != null ? fmtPct(recap.regime.spyReturnPct, 1) : '—'}
          positive={(recap.regime.spyReturnPct ?? 0) >= 0}
        />
      </div>

      {/* ── Per-mode breakdown ────────────────────────────────────────────── */}
      <div className="card-glass border border-[#252840] rounded-lg p-4">
        <div className="text-[11px] uppercase tracking-wider text-[#7c82a0] mb-3">By AI Mode</div>
        <div className="space-y-1.5">
          <div className="grid grid-cols-12 text-[10px] uppercase tracking-wider text-[#4a5070] pb-1 border-b border-[#252840]">
            <div className="col-span-3">Mode</div>
            <div className="col-span-1 text-right">N</div>
            <div className="col-span-2 text-right">Hit</div>
            <div className="col-span-3 text-right">Expectancy</div>
            <div className="col-span-3 text-right">P&L</div>
          </div>
          {recap.byMode.map((m) => (
            <div key={m.aiMode} className="grid grid-cols-12 text-xs items-center py-1">
              <div className="col-span-3 text-[#e8eaf0] truncate">{MODE_LABELS[m.aiMode] ?? m.aiMode}</div>
              <div className="col-span-1 text-right font-mono text-[#7c82a0]">{m.count}</div>
              <div className="col-span-2 text-right font-mono">
                {m.wins + m.losses > 0 ? (
                  <span className={m.hitRatePct >= 50 ? 'text-emerald-400' : 'text-red-400'}>
                    {m.hitRatePct.toFixed(0)}%
                  </span>
                ) : <span className="text-[#4a5070]">—</span>}
              </div>
              <div className="col-span-3 text-right font-mono">
                <span className={m.expectancyPct >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                  {fmtPct(m.expectancyPct, 2)}
                </span>
              </div>
              <div className="col-span-3 text-right font-mono">
                <span className={m.totalPnlDollars >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                  {fmtUSD(m.totalPnlDollars)}
                </span>
              </div>
            </div>
          ))}
        </div>
        <div className="text-[10px] text-[#4a5070] mt-3">
          Win = pnl ≥ +1% · loss ≤ −1% · n=count includes all decided + dismissed counterfactuals.
          Mark-to-market for open positions; avg-cost for closed (approximate).
        </div>
      </div>

      {/* ── AI Review output ──────────────────────────────────────────────── */}
      {review && (
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          className="card-glass border border-purple-500/40 rounded-lg p-4 space-y-3"
        >
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-purple-400" />
            <div className="text-xs uppercase tracking-wider text-purple-300 font-semibold">AI Review</div>
            {review.paused && (
              <span className="text-[10px] text-amber-400 ml-auto">Automation paused — re-enable AI Live to review</span>
            )}
          </div>

          {review.keyFindings.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-[#7c82a0] mb-1.5">Key findings</div>
              <ul className="space-y-1">
                {review.keyFindings.map((f, i) => (
                  <li key={i} className="text-xs text-[#e8eaf0] flex gap-2">
                    <span className="text-purple-400 flex-shrink-0">•</span>
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {review.rationale && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-[#7c82a0] mb-1.5">Rationale</div>
              <div className="text-xs text-[#a8aec8] leading-relaxed">{review.rationale}</div>
            </div>
          )}

          {hasProposal ? (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-[#7c82a0] mb-1.5">Proposed target changes</div>
              <div className="space-y-1.5">
                {proposedKeys.map((k) => {
                  const cur = currentTargets[k];
                  const next = review.proposed[k]!;
                  const delta = next - cur;
                  return (
                    <div key={k} className="flex items-center justify-between text-xs bg-[#1a1d27]/60 rounded px-2.5 py-1.5">
                      <div className="text-[#a8aec8] capitalize">{labelFor(k)}</div>
                      <div className="flex items-center gap-2 font-mono">
                        <span className="text-[#7c82a0]">{cur}</span>
                        <ArrowRight className="w-3 h-3 text-[#4a5070]" />
                        <span className="text-white font-semibold">{next}</span>
                        <span className={delta >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                          ({delta >= 0 ? '+' : ''}{delta.toFixed(1)})
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="flex items-center gap-2 mt-3">
                <button
                  onClick={applyProposed}
                  className="text-[11px] px-3 py-1.5 rounded bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/25 transition-colors flex items-center gap-1.5 font-semibold"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" /> Apply to Settings
                </button>
                <button
                  onClick={() => setReview(null)}
                  className="text-[11px] px-3 py-1.5 rounded text-[#7c82a0] border border-[#252840] hover:bg-white/[0.04] transition-colors"
                >
                  Dismiss
                </button>
              </div>
            </div>
          ) : (
            <div className="text-xs text-[#7c82a0] italic">
              No target changes proposed — Claude judged the data insufficient or the current targets sound.
            </div>
          )}
        </motion.div>
      )}
    </div>
  );
}

function Metric({ label, value, positive }: { label: string; value: string; positive: boolean }) {
  const Arrow = positive ? TrendingUp : TrendingDown;
  return (
    <div className="card-glass border border-[#252840] rounded-lg p-3">
      <div className="text-[10px] uppercase tracking-wider text-[#7c82a0] mb-1">{label}</div>
      <div className={`text-lg font-extrabold tracking-tight flex items-center gap-1.5 ${positive ? 'text-emerald-400' : 'text-red-400'}`}>
        <Arrow className="w-3.5 h-3.5" />
        {value}
      </div>
    </div>
  );
}

function labelFor(k: keyof StrategyTargets): string {
  const map: Record<keyof StrategyTargets, string> = {
    triplesPct:     'Triples %',
    cornerstonePct: 'Cornerstone %',
    incomePct:      'Income %',
    hedgePct:       'Hedge %',
    marginLimitPct: 'Margin limit %',
    marginWarnPct:  'Margin warn %',
    familyCapPct:   'Family cap %',
    fireNumber:     'FIRE target $',
    marginRatePct:  'Margin rate %',
  };
  return map[k];
}

'use client';

/**
 * IncomeProjectionCard — the clear main-page answer to "how much does this
 * portfolio pay me per month?"
 *
 * Replaces the vague FIRE pill as the primary income readout on the Today
 * view. Shows three numbers side by side — projected monthly (holdings ×
 * trailing distribution rates), actual last-30-day cash, and an editable
 * near-term income goal — then a progress bar against the goal, a capital-gap
 * hint when short, and a slim secondary FIRE-target bar for the long game.
 *
 * The near-term goal is stored in localStorage (same pattern as the FIRE tab
 * config in IncomeHub) so it survives reloads without a server round-trip.
 */

import React, { useMemo, useState } from 'react';
import {
  DollarSign, Pencil, Check, X, TrendingUp, AlertTriangle, ArrowRight, Flame,
} from 'lucide-react';
import type { EnrichedPosition } from '@/lib/schwab/types';
import { estimateAnnualDividend } from '@/components/IncomeHub';

const GOAL_STORAGE_KEY = 'triple-c-income-goal';
const DEFAULT_GOAL = 1500;

function loadGoal(): number {
  try {
    const raw = typeof window !== 'undefined' ? localStorage.getItem(GOAL_STORAGE_KEY) : null;
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_GOAL;
  } catch {
    return DEFAULT_GOAL;
  }
}

function fmt$(n: number, dec = 0): string {
  return n.toLocaleString('en-US', {
    style: 'currency', currency: 'USD',
    minimumFractionDigits: dec, maximumFractionDigits: dec,
  });
}

interface Props {
  positions: EnrichedPosition[];
  /** Actual dividend cash received in the trailing 30 days. */
  actualMonthly: number;
  /** Long-term FIRE monthly target from strategy settings. */
  fireTarget: number;
  /** Jump to the full Income Hub (Portfolio → Income). */
  onOpenIncomeHub?: () => void;
}

export function IncomeProjectionCard({ positions, actualMonthly, fireTarget, onOpenIncomeHub }: Props) {
  const [goal, setGoal] = useState<number>(loadGoal);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  // ── Projection from current holdings ────────────────────────────────────────
  const { projectedMonthly, blendedYieldPct, topPayers } = useMemo(() => {
    let annual = 0;
    let incomeValue = 0;
    const payers: { symbol: string; monthly: number }[] = [];

    for (const pos of positions) {
      if (pos.instrument?.assetType === 'OPTION') continue;
      const est = estimateAnnualDividend(pos);
      if (est < 1) continue;
      annual += est;
      incomeValue += Math.abs(pos.marketValue ?? 0);
      payers.push({ symbol: pos.instrument?.symbol ?? '?', monthly: est / 12 });
    }
    payers.sort((a, b) => b.monthly - a.monthly);

    return {
      projectedMonthly: annual / 12,
      blendedYieldPct: incomeValue > 0 ? (annual / incomeValue) * 100 : 0,
      topPayers: payers.slice(0, 5),
    };
  }, [positions]);

  const onTrack = projectedMonthly >= goal;
  const gap = goal - projectedMonthly;
  const goalPct = goal > 0 ? Math.min((projectedMonthly / goal) * 100, 100) : 0;
  const firePct = fireTarget > 0 ? Math.min((projectedMonthly / fireTarget) * 100, 100) : 0;

  // How much extra capital closes the gap at the current blended rate.
  const capitalToClose = !onTrack && blendedYieldPct > 0
    ? (gap * 12) / (blendedYieldPct / 100)
    : 0;

  function saveGoal() {
    const n = Number(draft);
    if (Number.isFinite(n) && n > 0) {
      setGoal(n);
      try { localStorage.setItem(GOAL_STORAGE_KEY, String(n)); } catch { /* ignore */ }
    }
    setEditing(false);
  }

  return (
    <div className="bg-[#12151f] border border-[#1f2334] rounded-xl p-4 space-y-4">

      {/* Header */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-md bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
            <DollarSign className="w-4 h-4 text-emerald-400" />
          </div>
          <span className="text-sm font-semibold text-white">Monthly income</span>
          <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
            onTrack
              ? 'bg-emerald-500/15 text-emerald-300'
              : 'bg-orange-500/15 text-orange-300'
          }`}>
            {onTrack ? 'On track' : `${fmt$(gap)}/mo short of goal`}
          </span>
        </div>
        {onOpenIncomeHub && (
          <button
            onClick={onOpenIncomeHub}
            className="flex items-center gap-1 text-[11px] text-blue-400 hover:text-blue-300 transition-colors"
          >
            Income Hub <ArrowRight className="w-3 h-3" />
          </button>
        )}
      </div>

      {/* Three numbers */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-[#0f1117] rounded-lg p-3">
          <div className="text-[10px] text-[#7c82a0] uppercase tracking-wider mb-0.5">Projected</div>
          <div className="text-xl font-bold text-violet-300 tabular-nums">
            {fmt$(projectedMonthly)}<span className="text-xs font-medium text-[#7c82a0]">/mo</span>
          </div>
          <div className="text-[10px] text-[#4a5070] leading-snug mt-0.5">
            from current holdings{blendedYieldPct > 0 ? ` · ~${blendedYieldPct.toFixed(0)}% blended` : ''}
          </div>
        </div>
        <div className="bg-[#0f1117] rounded-lg p-3">
          <div className="text-[10px] text-[#7c82a0] uppercase tracking-wider mb-0.5">Actual · 30d</div>
          <div className="text-xl font-bold text-emerald-400 tabular-nums">
            {fmt$(actualMonthly)}<span className="text-xs font-medium text-[#7c82a0]">/mo</span>
          </div>
          <div className="text-[10px] text-[#4a5070] leading-snug mt-0.5">cash actually paid</div>
        </div>
        <div className="bg-[#0f1117] rounded-lg p-3">
          <div className="text-[10px] text-[#7c82a0] uppercase tracking-wider mb-0.5">Goal</div>
          {editing ? (
            <div className="flex items-center gap-1">
              <input
                autoFocus
                type="number"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') saveGoal(); if (e.key === 'Escape') setEditing(false); }}
                className="w-full bg-[#1a1d27] border border-[#2d3248] rounded px-1.5 py-0.5 text-sm text-white focus:outline-none focus:border-blue-500 tabular-nums"
              />
              <button onClick={saveGoal} className="p-0.5 text-emerald-400 hover:text-emerald-300" aria-label="Save goal">
                <Check className="w-3.5 h-3.5" />
              </button>
              <button onClick={() => setEditing(false)} className="p-0.5 text-[#7c82a0] hover:text-white" aria-label="Cancel">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : (
            <button
              onClick={() => { setDraft(String(goal)); setEditing(true); }}
              className="group flex items-baseline gap-1.5"
              title="Edit monthly income goal"
            >
              <span className="text-xl font-bold text-white tabular-nums">
                {fmt$(goal)}<span className="text-xs font-medium text-[#7c82a0]">/mo</span>
              </span>
              <Pencil className="w-3 h-3 text-[#4a5070] group-hover:text-blue-400 transition-colors" />
            </button>
          )}
          <div className="text-[10px] text-[#4a5070] leading-snug mt-0.5">near-term target</div>
        </div>
      </div>

      {/* Goal progress bar */}
      <div className="space-y-1">
        <div className="flex justify-between text-[11px]">
          <span className="text-[#7c82a0]">
            Projected covers <span className={onTrack ? 'text-emerald-400 font-semibold' : 'text-orange-300 font-semibold'}>
              {goal > 0 ? ((projectedMonthly / goal) * 100).toFixed(0) : 0}%
            </span> of goal
          </span>
          <span className="text-[#4a5070] tabular-nums">{fmt$(projectedMonthly)} / {fmt$(goal)}</span>
        </div>
        <div className="w-full h-2.5 bg-[#1f2334] rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-700 ${onTrack ? 'bg-emerald-500' : 'bg-orange-500'}`}
            style={{ width: `${goalPct}%` }}
          />
        </div>
      </div>

      {/* Gap helper */}
      {!onTrack && capitalToClose > 0 && (
        <div className="flex items-start gap-2 bg-orange-500/10 border border-orange-500/20 rounded-lg px-3 py-2 text-[11px] text-orange-200 leading-relaxed">
          <TrendingUp className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          <span>
            ≈ {fmt$(capitalToClose)} more in your income sleeve at its current
            ~{blendedYieldPct.toFixed(0)}% blended rate would close the {fmt$(gap)}/mo gap.
          </span>
        </div>
      )}

      {/* FIRE secondary bar */}
      {fireTarget > 0 && (
        <div className="flex items-center gap-2.5">
          <Flame className="w-3.5 h-3.5 text-[#7c82a0] flex-shrink-0" />
          <span className="text-[11px] text-[#7c82a0] whitespace-nowrap">
            FIRE {fmt$(fireTarget)}/mo
          </span>
          <div className="flex-1 h-1.5 bg-[#1f2334] rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-700 ${firePct >= 100 ? 'bg-emerald-400' : 'bg-blue-500'}`}
              style={{ width: `${firePct}%` }}
            />
          </div>
          <span className="text-[11px] font-semibold tabular-nums text-[#9aa2c0]">{firePct.toFixed(0)}%</span>
        </div>
      )}

      {/* Top payers */}
      {topPayers.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[10px] text-[#7c82a0] uppercase tracking-wider">Top payers</div>
          {topPayers.map((p) => {
            const pct = projectedMonthly > 0 ? (p.monthly / projectedMonthly) * 100 : 0;
            return (
              <div key={p.symbol} className="flex items-center gap-2 text-[11px]">
                <span className="w-14 font-mono font-semibold text-white flex-shrink-0">{p.symbol}</span>
                <div className="flex-1 h-3.5 bg-[#1f2334] rounded-full overflow-hidden">
                  <div className="h-full rounded-full bg-violet-500/70" style={{ width: `${Math.min(pct * 2, 100)}%` }} />
                </div>
                <span className="w-16 text-right text-[#9aa2c0] tabular-nums">{fmt$(p.monthly)}/mo</span>
                <span className="w-8 text-right text-[#4a5070] tabular-nums">{pct.toFixed(0)}%</span>
              </div>
            );
          })}
        </div>
      )}

      <p className="flex items-start gap-1.5 text-[10px] text-[#4a5070] leading-relaxed">
        <AlertTriangle className="w-3 h-3 flex-shrink-0 mt-0.5" />
        <span>
          Projections use Schwab yields (fallback table otherwise). High-yield covered-call
          funds vary payouts and can erode NAV — the actual-30d number is the ground truth.
        </span>
      </p>
    </div>
  );
}
